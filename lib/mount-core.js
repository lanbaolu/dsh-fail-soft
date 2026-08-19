/**
 * @lanbaolu/dsh-fail-soft — mount 兜底核心（纯函数 + 文件操作，零 DSH 依赖，可独立测试）。
 *
 * 被 lib/mount.js（内核挂载兜底）与测试 / doctor 共用。本文件保持**无副作用**。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** profile 的 patch 文件名（DSH 官方约定）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** 隔离注释标记（用户可据此识别/清理被隔离的插件条目）。 */
export const QUARANTINE_MARKER = '@lanbaolu/dsh-fail-soft'

/** 写一行诊断到 stderr（带插件标识）。 */
export function diag(line) {
  process.stderr.write(`${line}\n`)
}

/**
 * 从嵌套的 loader 错误里收集所有失败的 entry，遍历 AggregateError 的
 * `errors` 与 `cause` 链。Loader 的错误格式为
 * `failed to <stage> loader entry <id> (<name>): …`；include 根
 * （id `include`）只是载体不是元凶，排除。
 * @returns 去重后的 `[{ id, name }]` 列表
 */
export function collectLoaderEntryFailures(error) {
  const texts = []
  const seen = new Set()
  const walk = (err) => {
    if (!err || seen.has(err)) return
    seen.add(err)
    texts.push(err instanceof Error ? err.message : String(err))
    if (Array.isArray(err.errors)) for (const child of err.errors) walk(child)
    if (err.cause) walk(err.cause)
  }
  walk(error)
  const found = []
  const seenIds = new Set()
  for (const text of texts) {
    for (const match of text.matchAll(/loader entry (\S+) \(([^)]+)\)/g)) {
      if (match[1] === 'include' && match[2] === 'cordis:include') continue
      if (seenIds.has(match[1])) continue
      seenIds.add(match[1])
      found.push({ id: match[1], name: match[2] })
    }
  }
  return found
}

/**
 * 把失败插件的 disabled patch 持久化进 profile 的 cordis.patch.yml。
 * 同 id 已存在则跳过（重复 id 会导致 loader duplicate id 崩溃）。
 * 读写失败不抛——诊断即兜底。
 * @returns 实际写入的 entry id 列表
 */
export function quarantineEntries(profileDir, failures) {
  const patchFile = join(profileDir, PROFILE_PATCH_FILENAME)
  let body = ''
  try {
    body = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  } catch (error) {
    diag(`@lanbaolu/dsh-fail-soft: cannot read quarantine target ${patchFile}: ${String(error)}`)
    return []
  }
  const existingIds = new Set()
  for (const line of body.split('\n')) {
    const match = /^\s*-\s*id:\s*([^\s#]+)/.exec(line)
    if (match) existingIds.add(match[1])
  }
  const stamp = new Date().toISOString()
  let block = ''
  const written = []
  for (const failure of failures) {
    const id = typeof failure.id === 'string' && failure.id.length > 0 ? failure.id : failure.entry?.options?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (existingIds.has(id)) continue
    existingIds.add(id)
    const firstLine = String(failure.message ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 200)
    block += `# quarantined by ${QUARANTINE_MARKER} at ${stamp} — ${id}: ${firstLine}\n- id: ${id}\n  disabled: true\n`
    written.push(id)
  }
  if (block.length === 0) return written
  try {
    writeFileSync(patchFile, body.length === 0 || body.endsWith('\n') ? body + block : body + '\n' + block)
  } catch (error) {
    diag(`@lanbaolu/dsh-fail-soft: cannot quarantine into ${patchFile}: ${String(error)}`)
    return []
  }
  return written
}

/**
 * 从 patch 栈剔除被隔离的插件（entry id 匹配即剔除整个 patch）。
 * @param patches 组装好的 patch 栈（bundle + profile + overlays）
 * @param quarantineIds 被隔离的 entry id 列表
 */
export function filterQuarantinedPatches(patches, quarantineIds) {
  const ids = new Set(quarantineIds)
  return patches.filter(
    (patch) => !Array.isArray(patch?.insert)
      || !patch.insert.some((entry) => entry?.id !== undefined && ids.has(entry.id)),
  )
}
