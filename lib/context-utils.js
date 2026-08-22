/**
 * @lanbaolu/dsh-fail-soft — cordis 上下文工具（零 DSH 依赖，可独立测试）。
 *
 * 与 mount-core / patch-ops 一样保持"零 DSH 依赖"：profileDirOf 与持久化
 * 开关在无 DSH 生态的 CI（GitHub Actions verify job，未装 peerDeps）里也能
 * 直接单测。不要把这三个函数放回 lib/index.js —— index.js 顶层
 * `import '@deepseek-ai/dsh-tools'`，被它引用的模块会让 `npm test` 在 CI 上
 * ERR_MODULE_NOT_FOUND（本插件 0.1.2 发布前的实测坑）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 持久化开关文件路径。默认 `~/.dsh/fail-soft.json`（与内核 isFailSoft 读取
 * 一致）；可用环境变量 `DSH_FAIL_SOFT_SWITCH_FILE` 覆盖——测试用它指向临时
 * 目录，避免在无 `~/.dsh` 的 CI runner 上 ENOENT，也不污染真实用户开关。
 */
export function failSoftSwitchFile() {
  return process.env.DSH_FAIL_SOFT_SWITCH_FILE || join(homedir(), '.dsh', 'fail-soft.json')
}

/**
 * 从 cordis ctx 推导 profile 目录。
 *
 * ⚠️ ctx.baseUrl 是 profile 目录的 URL，**以 '/' 结尾**（目录 URL）。因此
 * `fileURLToPath` 后得到带尾斜杠的目录路径，**去尾斜杠**即 profile 目录；
 * 绝不能 `dirname(fileURLToPath(ctx.baseUrl))` —— 尾斜杠会被当成文件名
 * 的一部分，dirname 误切到上级目录，隔离 patch 就写错了地方。
 *
 * 解析失败（缺 baseUrl / 非法 URL）返回 undefined，调用方按"无法定位
 * profile"降级处理，绝不 throw —— 本插件自己不能再成为挂载期的坏插件。
 */
export function profileDirOf(ctx) {
  try {
    const baseUrl = ctx?.baseUrl
    if (!baseUrl) return undefined
    return fileURLToPath(baseUrl).replace(/[\\/]+$/, '')
  } catch {
    return undefined
  }
}

/** 读取持久化开关：文件声明 `{ "enabled": true }` 时返回 true。 */
export function readFailSoftSwitch() {
  try {
    const data = JSON.parse(readFileSync(failSoftSwitchFile(), 'utf8'))
    return data?.enabled === true
  } catch {
    return false
  }
}

/**
 * 写入持久化开关（fail_soft_set_enabled 工具/API 调用）。 */
export function writeFailSoftSwitch(enabled) {
  try {
    const file = failSoftSwitchFile()
    writeFileSync(file, JSON.stringify({ enabled: !!enabled }, null, 2) + '\n')
    return { ok: true, file, enabled: !!enabled }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * 首次安装引导（0.1.14）：开关文件**不存在**时默认启用 fail-soft。
 *
 * 背景（2026-08-22"安装完就崩溃"反馈排查）：保护只在开关开启时生效，但
 * 新装默认关闭——用户环境里已有坏插件时，重启照崩，且服务起不来就无法
 * 通过 GUI/工具启用保护（引导死锁）。装一个防崩溃插件本身就构成启用同意，
 * 因此首装默认开；**文件已存在则一律尊重**（包括用户显式 `enabled: false`）。
 * 绝不抛错——引导失败只影响默认值，不能反过来弄坏插件激活。
 * @returns {{action: 'enabled-by-default'|'already-enabled'|'respected-disabled'|'failed', file?: string, error?: string}}
 */
export function ensureFailSoftSwitchDefault() {
  const file = failSoftSwitchFile()
  try {
    let existing = null
    try {
      existing = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      existing = null // 无文件/坏 JSON → 按"未设置"处理
    }
    if (existing && typeof existing === 'object') {
      return { action: existing.enabled === true ? 'already-enabled' : 'respected-disabled', file }
    }
    mkdirSync(dirname(file), { recursive: true }) // HOME 下可能还没有 .dsh 目录
    writeFileSync(file, JSON.stringify({ enabled: true }, null, 2) + '\n')
    return { action: 'enabled-by-default', file }
  } catch (error) {
    return { action: 'failed', file, error: String(error) }
  }
}
