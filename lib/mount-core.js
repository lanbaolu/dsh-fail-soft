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
 * 把一段隔离 block（`# quarantined by …` 注释 + `- id: …`/`disabled: true`
 * 条目）合并进 cordis.patch.yml 的现有正文，保证产出始终是**单个合法 YAML
 * 数组文档**。
 *
 * 背景（本插件 2026-08 的真实事故）：profile 的 cordis.patch.yml 默认内容
 * 是空数组字面量 `[]`（DSH 官方无补丁时的形态）。若在 `[]` 后盲目追加
 * `- id: …`，YAML 会把 `[]` 视为一个完整文档、后续列表元素视为第二个文档
 * 的开头，解析器抛
 * `YAMLException: end of the stream or a document separator is expected`，
 * 整个服务起不来——隔离器自己制造了它本应防止的问题。
 *
 * 策略：
 * - 正文已是列表（含 `- id:`）或只有注释/空 → 直接追加（保持原形态）；
 * - 正文主体是空数组 `[]`（可能带注释）→ 用 block **替换** `[]` 行，
 *   而不是追加。
 * @param body 现有文件内容
 * @param block 要写入的条目块（每行以 \n 结尾）
 * @returns 合并后的新内容（始终合法）
 */
export function mergePatchBlock(body, block) {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n')
  const isList = /^\s*-\s*id:/.test(normalized)
  if (!isList) {
    const lines = normalized.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\[\s*\]\s*$/.test(lines[i])) {
        lines[i] = block.replace(/\n$/, '')
        return lines.join('\n')
      }
    }
  }
  return normalized.length === 0 || normalized.endsWith('\n')
    ? normalized + block
    : normalized + '\n' + block
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
    writeFileSync(patchFile, mergePatchBlock(body, block))
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
