/**
 * dsh-fail-soft — 内核补丁自愈模块（heal）。
 *
 * DSH 官方更新时（npx 重新拉取到新的 ~/.npm/_npx/<hash>/ 目录），内核补丁
 * （@deepseek-ai/dsh-app-boot + @deepseek-ai/dsh/lib/profile-boot-*.js）会
 * 丢失。本模块在插件每次 apply 时运行，自动：
 *   1. 动态定位实际运行的 DSH 安装目录（不硬编码 npx hash）；
 *   2. 检测内核补丁状态（已打 / 原始版可重打 / 官方已改动需适配）；
 *   3. 安全重打补丁（仅当目标与"已知原始版"一致，或用特征锚点重生成）；
 *   4. 官方改动后无法自动适配时，给出明确报告（不破坏任何文件）。
 *
 * ⚠️ 本文件必须无副作用：被 lib/index.js 动态 import。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PATCH_MARKER = 'dsh-fail-soft'

/**
 * 返回 ~/.npm/_npx 下所有含 @deepseek-ai/dsh-app-boot 的 node_modules 目录，
 * 按目录 mtime 降序（最新的排前面）。同时返回各自 dsh-app-boot 版本。
 * @returns {Array<{dir: string, version: string, mtime: number}>}
 */
export function findDshInstalls() {
  const npxRoot = join(homedir(), '.npm', '_npx')
  const found = []
  let hashes = []
  try {
    hashes = readdirSync(npxRoot)
  } catch {
    return found
  }
  for (const hash of hashes) {
    const nm = join(npxRoot, hash, 'node_modules')
    const pkg = join(nm, '@deepseek-ai', 'dsh-app-boot', 'package.json')
    if (!existsSync(pkg)) continue
    let version = '?'
    try {
      version = JSON.parse(readFileSync(pkg, 'utf8')).version
    } catch { /* ignore */ }
    let mtime = 0
    try { mtime = statSync(join(npxRoot, hash)).mtimeMs } catch { /* ignore */ }
    found.push({ dir: nm, hash, version, mtime })
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found
}

/**
 * 从当前进程 argv 推断实际运行的 DSH 安装目录（最可靠），
 * 失败则回退到最新的 _npx 目录。
 * @returns {string|null} node_modules 目录绝对路径
 */
export function detectActiveInstall() {
  // 1) 进程 argv：`.../node_modules/@deepseek-ai/dsh/lib/bin.js web`
  for (const arg of process.argv) {
    const idx = arg.indexOf('node_modules/@deepseek-ai/dsh')
    if (idx > 0) return arg.slice(0, idx + 'node_modules'.length)
  }
  // 2) 回退：最新目录
  const list = findDshInstalls()
  return list.length ? list[0].dir : null
}

/** sha256 摘要。 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** glob 一个目录下匹配 pattern 的文件名（仅一层）。 */
function listMatching(dir, prefix, suffix) {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** 备份目录（与 patch-apply.mjs 共用 backup/）。 */
function backupDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'backup')
}

/**
 * 检测一个 DSH 安装目录的内核补丁状态。
 * @returns {Promise<{
 *   dir: string, version: string,
 *   appBoot: {status: 'applied'|'pristine'|'changed'|'missing', file: string},
 *   profileBoot: {status: 'applied'|'pristine'|'changed'|'missing', files: string[]},
 *   overall: 'ok'|'needs-apply'|'needs-adaptation'
 * }>}
 */
export async function checkPatch(installDir) {
  const bd = backupDir()
  const appBoot = join(installDir, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  const dshLib = join(installDir, '@deepseek-ai', 'dsh', 'lib')
  const profileBoots = listMatching(dshLib, 'profile-boot-', '.js')

  let appSt = 'missing'
  if (existsSync(appBoot)) {
    const appHash = sha256(appBoot)
    const orig = join(bd, 'dsh-app-boot.index.js.orig')
    const patched = join(bd, 'dsh-app-boot.index.js.patched')
    if (existsSync(patched) && appHash === sha256(patched)) appSt = 'applied'
    else if (existsSync(orig) && appHash === sha256(orig)) appSt = 'pristine'
    else appSt = 'changed'
  }

  // 只关心"含 installFailLoud 的 profile-boot"（补丁目标）；其余变体（如
  // 不同构建的 profile-boot-*.js）与本补丁无关，忽略，避免误判 changed。
  const pbCandidates = profileBoots.filter(pbContainsInstallFailLoud)
  let pbStatus = 'missing'
  const pbFiles = []
  for (const pb of pbCandidates) {
    pbFiles.push(pb)
    const h = sha256(pb)
    const orig = join(bd, 'dsh-profile-boot.js.orig')
    const patched = join(bd, 'dsh-profile-boot.js.patched')
    if (pbStatus === 'missing') {
      if (existsSync(patched) && h === sha256(patched)) pbStatus = 'applied'
      else if (existsSync(orig) && h === sha256(orig)) pbStatus = 'pristine'
      else pbStatus = 'changed'
    }
  }
  if (pbCandidates.length === 0 && profileBoots.length > 0) {
    // 没有任何 profile-boot 含 installFailLoud——官方可能改名/改结构
    pbStatus = 'changed'
  }

  let version = '?'
  try {
    version = JSON.parse(readFileSync(join(installDir, '@deepseek-ai', 'dsh-app-boot', 'package.json'), 'utf8')).version
  } catch { /* ignore */ }

  const overall =
    appSt === 'applied' && pbStatus === 'applied' ? 'ok'
    : appSt === 'changed' || pbStatus === 'changed' ? 'needs-adaptation'
    : 'needs-apply'

  return {
    dir: installDir,
    version,
    appBoot: { status: appSt, file: appBoot },
    profileBoot: { status: pbStatus, files: pbFiles },
    overall,
  }
}

/**
 * 备份一个文件到 backup/ 的指定名字（若同名不存在）。
 */
function backupOnce(file, name) {
  const target = join(backupDir(), name)
  if (!existsSync(target) && existsSync(file)) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(file, target)
    return true
  }
  return false
}

/**
 * 应用补丁到指定安装目录。策略：
 *  - app-boot/index.js：目标 == 备份的 orig → 用 patched 覆盖（官方未改，安全）；
 *    目标 == patched → 已打，跳过；否则（官方改动）→ 抛 needs-adaptation。
 *  - profile-boot-*.js：按内容匹配 orig/patched 处理（文件名 hash 可变）。
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 */
export async function applyPatch(installDir) {
  const bd = backupDir()
  const origApp = join(bd, 'dsh-app-boot.index.js.orig')
  const patchedApp = join(bd, 'dsh-app-boot.index.js.patched')
  const origPb = join(bd, 'dsh-profile-boot.js.orig')
  const patchedPb = join(bd, 'dsh-profile-boot.js.patched')

  // 缺少备份 = 没有可用的补丁模板 → 无法自动重打
  if (!existsSync(origApp) || !existsSync(patchedApp) || !existsSync(origPb) || !existsSync(patchedPb)) {
    throw new Error('heal: 缺少 backup/ 里的补丁模板（orig/patched），无法自动重打；请先运行 patch-apply.mjs 初始化一次')
  }

  const applied = []
  const skipped = []

  // ---- app-boot ----
  const appBoot = join(installDir, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  if (!existsSync(appBoot)) throw new Error(`heal: 找不到 ${appBoot}`)
  const appHash = sha256(appBoot)
  if (appHash === sha256(patchedApp)) {
    skipped.push('dsh-app-boot (已打)')
  } else if (appHash === sha256(origApp)) {
    copyFileSync(patchedApp, appBoot)
    applied.push('dsh-app-boot')
  } else {
    throw new Error(`heal: dsh-app-boot 与已知原始版不一致（官方可能已更新到新版本）——自动重打会破坏新版代码，已中止；请人工适配补丁（更新 backup/ 后重试）`)
  }

  // ---- profile-boot-* ----
  const dshLib = join(installDir, '@deepseek-ai', 'dsh', 'lib')
  const profileBoots = listMatching(dshLib, 'profile-boot-', '.js')
  if (profileBoots.length === 0) throw new Error(`heal: 找不到 profile-boot-*.js（官方可能已改名）`)
  let pbFound = false
  for (const pb of profileBoots) {
    const h = sha256(pb)
    if (h === sha256(patchedPb)) {
      skipped.push(`profile-boot (已打: ${basename(pb)})`)
      pbFound = true
    } else if (h === sha256(origPb)) {
      copyFileSync(patchedPb, pb)
      applied.push(`profile-boot (${basename(pb)})`)
      pbFound = true
    }
  }
  if (!pbFound) {
    // 官方更新后 profile-boot 内容变了：尝试特征重打（给 installFailLoud 调用补 profileDir 参数）
    const adapted = profileBoots.filter((pb) => pbContainsInstallFailLoud(pb) && !pbContainsProfileDir(pb))
    if (adapted.length > 0) {
      for (const pb of adapted) {
        applyInstallFailLoudProfileDir(pb)
        applied.push(`profile-boot (${basename(pb)}, 特征重打)`)
        pbFound = true
      }
    }
  }
  if (!pbFound) {
    throw new Error('heal: profile-boot 无法自动适配（官方已改动结构），请人工适配补丁')
  }

  return { applied, skipped }
}

/** basename 快捷实现。 */
function basename(p) {
  return p.split(/[\\/]/).pop()
}

/** profile-boot 是否含 installFailLoud 调用（特征锚点）。 */
function pbContainsInstallFailLoud(file) {
  try {
    return readFileSync(file, 'utf8').includes('installFailLoud(')
  } catch {
    return false
  }
}

/** profile-boot 是否已含 profileDir 传入（补丁特征，仅匹配 installFailLoud 调用内）。 */
function pbContainsProfileDir(file) {
  try {
    // 已打补丁的调用形如 installFailLoud(NAME, process, async () => {...}, composed.profile.dir)
    return /installFailLoud\([^)]*composed\.profile\.dir/.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/**
 * 特征重打：给 installFailLoud 的调用补上 profileDir 第4参数。
 * 匹配模式（官方现状）：`installFailLoud(NAME, process, async () => {...})`
 * 在 `process` 之后插入 `, composed.profile.dir`。
 * 仅当目标确为未打补丁的官方原版（含 installFailLoud 且调用内无 profileDir）时执行。
 * @returns {boolean} 是否成功修改
 */
function applyInstallFailLoudProfileDir(file) {
  const src = readFileSync(file, 'utf8')
  // 已含参数则跳过
  if (pbContainsProfileDir(file)) return false
  const anchor = 'installFailLoud('
  let idx = src.indexOf(anchor)
  if (idx < 0) return false
  // 找该调用内的 `process,`（形如 installFailLoud(NAME, process, ...)）
  const after = src.indexOf('process,', idx)
  if (after < 0) return false
  const inserted = ', composed.profile.dir'
  const out = src.slice(0, after + 'process'.length) + inserted + src.slice(after + 'process'.length)
  writeFileSync(file, out)
  return true
}

/**
 * 一键自愈：定位 → 检测 → 按需重打 → 返回报告。
 * 不抛错（错误作为报告字段返回），保证插件启动不被阻塞。
 * @returns {Promise<object>}
 */
export async function heal() {
  const report = { at: new Date().toISOString(), steps: [] }
  try {
    const installDir = detectActiveInstall()
    if (!installDir) {
      report.status = 'no-install'
      report.error = '无法定位 DSH 安装目录'
      return report
    }
    report.installDir = installDir
    const before = await checkPatch(installDir)
    report.before = before.overall
    if (before.overall === 'ok') {
      report.status = 'ok'
      report.message = '内核补丁已生效，无需处理'
      return report
    }
    if (before.overall === 'needs-adaptation') {
      report.status = 'needs-adaptation'
      report.error = `DSH 内核已更新到 ${before.version}，自动补丁无法直接套用：dsh-app-boot=${before.appBoot.status}，profile-boot=${before.profileBoot.status}。请更新 backup/ 补丁模板后重跑 patch-apply.mjs`
      return report
    }
    // needs-apply → 重打
    const result = await applyPatch(installDir)
    report.applied = result.applied
    report.skipped = result.skipped
    const after = await checkPatch(installDir)
    report.after = after.overall
    report.status = after.overall === 'ok' ? 'repaired' : 'failed'
    if (report.status === 'failed') report.error = '重打后仍不完整，请人工检查'
    return report
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
    return report
  }
}

/**
 * 给 doctor / 外部管理面使用的补丁健康查询入口（不抛错）。
 * 与 heal() 的检测逻辑一致，但只查询不重打，可被 suite:doctor 直接调用。
 * @param {string|null} installDir 可选；缺省自动定位活动 DSH 安装
 * @returns {Promise<{status: string, version?: string, dir?: string, at: string, error?: string}>}
 */
export async function getPatchStatus(installDir = null) {
  const dir = installDir ?? detectActiveInstall()
  const at = new Date().toISOString()
  if (!dir) return { status: 'no-install', error: '无法定位 DSH 安装目录', at }
  if (!existsSync(dir)) return { status: 'no-install', error: `DSH 安装目录不存在: ${dir}`, at }
  const check = await checkPatch(dir)
  return {
    status: check.overall, // 'ok' | 'needs-apply' | 'needs-adaptation'
    version: check.version,
    dir: check.dir,
    appBoot: check.appBoot,
    profileBoot: check.profileBoot,
    at,
  }
}

export default heal
