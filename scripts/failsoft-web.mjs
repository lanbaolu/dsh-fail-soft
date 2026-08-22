#!/usr/bin/env node
/**
 * @lanbaolu/dsh-fail-soft — dsh-failsoft-web：进程级启动包装器（三层金字塔·第 2 层）。
 *
 * 为什么需要：第 1 层（内核挂载前兜底）覆盖"加载/激活崩溃"；但若内核补丁失效、
 * 首次安装窗口、或 fail-soft 自身没起来，第 1 层兜不住。本包装器把兜底搬到
 * **进程外**：外层进程与一切插件解耦，dsh 崩溃 → 诊断是否插件 → 隔离后带退避重拉。
 *
 * 用法：
 *   node scripts/failsoft-web.mjs                    # 拉起 dsh web（外层兜底）
 *   node scripts/failsoft-web.mjs -- --port 3080      # 透传参数给 dsh web
 *   node scripts/failsoft-web.mjs --max-restarts 3 --backoff-ms 2000
 *
 * 行为：
 *   - dsh 正常退出(0) → 透传退出
 *   - dsh 崩溃(非0) + fail-soft 隔离数增加 → 坏插件已被剔除，带退避自动重拉
 *   - dsh 崩溃 + 无新隔离 → 疑似非插件问题，跑 doctor 诊断，最多再给一次机会
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runDoctor, STATUS_READY } from '../lib/doctor.js'

const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const MAX_RESTARTS = Number(argValue('--max-restarts') ?? 3)
const BACKOFF_MS = Number(argValue('--backoff-ms') ?? 2000)
const DSH_BIN = argValue('--dsh') ?? null // 显式 dsh bin.js（App 内建用）；缺省走 PATH 的 dsh 命令
const DASH = process.argv.indexOf('--')
const WEB_ARGS = DASH >= 0 ? process.argv.slice(DASH + 1) : []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => process.stdout.write(`[failsoft-web] ${m}\n`)

// ── 信号转发：App 退出时终止子 dsh（包装器本身不吞信号）──
const children = new Set()
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`收到 ${sig}，转发给 dsh 子进程`)
    for (const c of children) { try { c.kill(sig) } catch { /* ignore */ } }
    // 留 2s 让 dsh 收尾，随后退出
    setTimeout(() => process.exit(0), 2000)
  })
}

function profileDir() {
  return join(homedir(), '.dsh', 'profiles', PROFILE)
}

/** 当前 fail-soft 隔离数（读 profile patch；读不到返回 -1）。 */
async function quarantineCount() {
  try {
    const req = createRequire(join(profileDir(), 'package.json'))
    const ops = await import(pathToFileURL(req.resolve('@lanbaolu/dsh-fail-soft/lib/patch-ops.js')).href)
    const { entries } = ops.readPatchEntries(profileDir())
    return entries.filter((e) => e.quarantined).length
  } catch {
    return -1
  }
}

/** 纯函数：根据崩溃信息决定是否重拉（便于测试）。 */
export function decideRestart({ code, quarantinedNew, restarts, maxRestarts }) {
  if (code === 0) return { restart: false, reason: 'normal-exit' }
  if (quarantinedNew > 0) {
    // 坏插件已被 fail-soft 剔除 → 重拉有望成功
    return restarts < maxRestarts
      ? { restart: true, reason: 'quarantined', quarantinedNew }
      : { restart: false, reason: 'max-restarts' }
  }
  // 无新隔离：非插件崩溃 → 只给一次机会
  return restarts === 0
    ? { restart: true, reason: 'unknown-once' }
    : { restart: false, reason: 'not-plugin' }
}

async function doctorSummary() {
  try {
    const req = createRequire(join(profileDir(), 'package.json'))
    const healPath = req.resolve('@lanbaolu/dsh-fail-soft/lib/heal.js')
    const { getPatchStatus } = await import(pathToFileURL(healPath).href)
    return await runDoctor({
      checkPatch: () => getPatchStatus(),
      checkInjectorRegistry: () => ({ ok: true }),
      checkHubService: () => ({ ok: true }),
    })
  } catch (e) {
    return { status: 'FIX', error: `doctor 不可用：${e instanceof Error ? e.message : String(e)}` }
  }
}

async function main() {
  if (!existsSync(join(profileDir(), 'package.json'))) {
    log(`profile "${PROFILE}" 不存在（${profileDir()}）——先运行一次 dsh web 生成`)
    process.exit(1)
  }

  log(`进程级兜底启动：profile=${PROFILE} maxRestarts=${MAX_RESTARTS} args=${WEB_ARGS.join(' ') || '(默认 dsh web)'}`)
  let restarts = 0
  let lastQuarantine = await quarantineCount()
  log(`启动前 fail-soft 隔离数：${lastQuarantine}`)

  for (;;) {
    // 显式 dsh bin.js → 用 node 执行；否则走 PATH 的 dsh 命令
    const cmd = DSH_BIN ? process.execPath : 'dsh'
    const cmdArgs = DSH_BIN ? [DSH_BIN, 'web', ...WEB_ARGS] : ['web', ...WEB_ARGS]
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit' })
    children.add(child)
    log(`dsh web 已拉起（pid ${child.pid ?? '?'}${DSH_BIN ? `, bin=${DSH_BIN}` : ''}）`)
    const code = await new Promise((resolve) => child.on('close', resolve))
    children.delete(child)

    const nowQuarantine = await quarantineCount()
    const quarantinedNew = nowQuarantine >= 0 && lastQuarantine >= 0 ? nowQuarantine - lastQuarantine : 0
    const decision = decideRestart({ code, quarantinedNew, restarts, maxRestarts: MAX_RESTARTS })

    if (decision.reason === 'normal-exit') {
      log(`dsh 正常退出（code ${code}）`)
      process.exit(0)
    }
    log(`dsh 崩溃（code ${code}）— 新隔离 ${quarantinedNew} 个 — 决策：${decision.reason}`)

    if (decision.reason === 'not-plugin') {
      const d = await doctorSummary()
      log(`未检测到插件隔离，doctor：${d.status}`)
      log(JSON.stringify(d.blockers ?? d.error ?? [], null, 2))
      log('疑似非插件问题，停止自动重拉（请查看上方诊断）')
      process.exit(code ?? 1)
    }
    if (decision.reason === 'max-restarts') {
      log(`重拉已达上限（${MAX_RESTARTS} 次），停止`)
      process.exit(code ?? 1)
    }

    if (quarantinedNew > 0) lastQuarantine = nowQuarantine
    restarts++
    const wait = BACKOFF_MS * 2 ** restarts
    log(`${wait}ms 后第 ${restarts}/${MAX_RESTARTS} 次重拉…`)
    await sleep(wait)
  }
}

// 仅在直接运行时执行（测试 import 时不拉起 dsh）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[failsoft-web] 致命错误：${String(e)}\n`)
    process.exit(1)
  })
}
