/**
 * @lanbaolu/dsh-fail-soft — mount 兜底模块（被 DSH 内核动态 import，不走 cordis 插件树）。
 *
 * DSH 内核（@deepseek-ai/dsh-app-boot）在 DSH_FAIL_SOFT=1 且本模块可解析时，
 * 用 mountFailSoft 替换默认的 include 树挂载：坏插件被自动隔离（写
 * disabled patch 到 profile 的 cordis.patch.yml），并从 patch 栈剔除后重试，
 * 其余插件照常启动。
 *
 * ⚠️ 本文件必须无副作用：内核在 include 树挂载之前 import 它，任何顶层
 * 副作用都会提前执行。纯函数逻辑在 mount-core.js（零 DSH 依赖，可测）。
 */
import { dirname, join } from 'node:path'
import { mountRootInclude, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import {
  QUARANTINE_MARKER,
  collectLoaderEntryFailures,
  quarantineEntries,
  filterQuarantinedPatches,
  diag,
} from './mount-core.js'

/** 最大隔离重试轮数（每轮隔离一个坏插件）。 */
export const MAX_REMOUNT_ATTEMPTS = 5

/** 插件标识前缀（内核内置 fallback 无此前缀，据此可确认插件版生效）。 */
const PLUGIN_TAG = '[fail-soft][plugin @lanbaolu/dsh-fail-soft]'

export { QUARANTINE_MARKER, collectLoaderEntryFailures, quarantineEntries }

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
      const quarantineIds = found.map((failure) => failure.id)
      const filtered = filterQuarantinedPatches(remaining, quarantineIds)
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
