/**
 * @lanbaolu/dsh-fail-soft — mount 兜底模块（被 DSH 内核动态 import，不走 cordis 插件树）。
 *
 * DSH 内核（@deepseek-ai/dsh-app-boot）在 DSH_FAIL_SOFT=1 且本模块可解析时，
 * 用 mountFailSoft 替换默认的 include 树挂载：坏插件被自动隔离（写
 * disabled patch 到 profile 的 cordis.patch.yml），并从 patch 栈剔除后重试，
 * 其余插件照常启动。
 *
 * ⚠️ 本文件必须无副作用：内核在 include 树挂载之前 import 它，任何顶层
 * 副作用都会提前执行。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountRootInclude, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'

/** 隔离注释标记（用户可据此识别/清理被隔离的插件条目）。 */
export const QUARANTINE_MARKER = '@lanbaolu/dsh-fail-soft'

/** 最大隔离重试轮数（每轮隔离一个坏插件）。 */
export const MAX_REMOUNT_ATTEMPTS = 5

/** 写一行诊断到 stderr（带插件标识，便于确认委托路径）。 */
function diag(line) {
  process.stderr.write(`${line}\n`)
}

/** 插件标识前缀（内核内置 fallback 无此前缀，据此可确认插件版生效）。 */
const PLUGIN_TAG = '[fail-soft][plugin @lanbaolu/dsh-fail-soft]'

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
 * fail-soft 版 include 树挂载：坏插件 → 隔离 → 剔除重试。
 * @param binName 诊断前缀（如 "dsh"）
 * @param ctx 启动中的根上下文
 * @param absoluteConfigPath 根配置（cordis.yml）绝对路径，profile 目录由其推导
 * @param patches 组装好的 patch 栈（bundle + profile + overlays）
 * @param bareModuleBaseUrl 透传给 mountRootInclude
 * @returns 挂载出的 include entry；放弃时返回 undefined
 */
export async function mountFailSoft(binName, ctx, absoluteConfigPath, patches, bareModuleBaseUrl) {
  let remaining = patches
  for (let attempt = 0; ; attempt++) {
    try {
      return await mountRootInclude(ctx, absoluteConfigPath, remaining, bareModuleBaseUrl)
    } catch (error) {
      const found = collectLoaderEntryFailures(error)
      const profileDir = dirname(absoluteConfigPath)
      const detail = error instanceof Error ? error.message : String(error)
      if (found.length === 0) {
        diag(`${binName}: ${PLUGIN_TAG} plugin tree failed to mount (no plugin entry to quarantine): ${detail}`)
        return undefined
      }
      for (const failure of found) {
        diag(`${binName}: ${PLUGIN_TAG} plugin "${failure.name}" (entry ${failure.id}) failed to activate: ${detail}`)
        quarantineEntries(profileDir, [{ id: failure.id, message: `${failure.name}: ${detail}` }])
      }
      const quarantineIds = new Set(found.map((failure) => failure.id))
      const filtered = remaining.filter((patch) => !Array.isArray(patch?.insert) || !patch.insert.some((entry) => entry?.id !== undefined && quarantineIds.has(entry.id)))
      if (filtered.length === remaining.length || attempt >= MAX_REMOUNT_ATTEMPTS) {
        diag(`${binName}: ${PLUGIN_TAG} gave up remounting after quarantining ${found.map((f) => `"${f.name}" (${f.id})`).join(', ')}; the service continues with a degraded plugin tree`)
        return undefined
      }
      diag(`${binName}: ${PLUGIN_TAG} quarantined ${found.map((f) => `"${f.name}" (entry ${f.id})`).join(', ')} — wrote disabled patch into ${join(profileDir, PROFILE_PATCH_FILENAME)}; retrying the mount without them. Fix the plugin(s), then remove those entries to re-enable.`)
      remaining = filtered
    }
  }
}

export default mountFailSoft
