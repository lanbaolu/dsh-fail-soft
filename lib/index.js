/**
 * @lanbaolu/dsh-fail-soft — 插件错误自动隔离。
 *
 * 两个组成部分：
 *  1. mount 兜底（lib/mount.js）：被 DSH 内核在 include 树挂载前动态加载，
 *     坏插件 → 自动隔离（写 disabled patch）→ 剔除重试挂载 → 服务照常起。
 *  2. 本模块（cordis 插件入口）：运行期管理——隔离列表查询、恢复、手动
 *     隔离（failSoft 服务 + fail_soft_* 工具 + /api/fail-soft/* HTTP API +
 *     client 面板）。
 */
import { readPatchEntries, removePatchEntry, quarantinePlugin, fixDuplicatePatchIds, QUARANTINE_MARKER } from './patch-ops.js'
import { profileDirOf, readFailSoftSwitch, writeFailSoftSwitch, ensureFailSoftSwitchDefault } from './context-utils.js'

// ═══ defineTool 懒加载（0.1.14 修复①）═══
// 顶层静态 import '@deepseek-ai/dsh-tools' 曾是本插件唯一的硬 peer 导入：
// 一旦运行环境解析不到它（pnpm 不装 peer、模块回退链变化等），整个 bundle
// entry 直接 ERR_MODULE_NOT_FOUND——"装个防崩溃插件反而让 DSH 起不来"。
// 改为动态 import：解析失败只降级"工具注册"（管理 API/UI 照常），不影响激活。
let defineToolPromise = null
function loadDefineTool() {
  defineToolPromise ??= import('@deepseek-ai/dsh-tools').then((mod) => mod.defineTool).catch(() => null)
  return defineToolPromise
}

export const name = '@lanbaolu/dsh-fail-soft'
// 不声明硬 inject：tools/webServer 仅在可用时增强（缺 base 的 profile 里
// 本插件照常激活，failSoft 服务始终可用）。

export function apply(ctx) {
  const profileDir = profileDirOf(ctx)

  // ═══ 首次安装引导（0.1.14 修复③）：开关文件不存在时默认启用 ═══
  // 保护只在开关开启时生效；新装默认关会让"已有坏插件"的用户重启照崩，
  // 且服务起不来就进不了 GUI 开保护（引导死锁）。装防崩溃插件本身即启用
  // 同意——默认开；已存在的开关文件一律尊重（含显式 false）。
  const switchBootstrap = ensureFailSoftSwitchDefault()
  if (switchBootstrap.action === 'enabled-by-default') {
    ctx.logger?.info?.('[@lanbaolu/dsh-fail-soft] 首次安装，fail-soft 已默认启用（写入 %s）；下次重启生效。可用 fail_soft_set_enabled(false) 关闭', switchBootstrap.file)
  } else if (switchBootstrap.action === 'failed') {
    ctx.logger?.warn?.('[@lanbaolu/dsh-fail-soft] 首装默认启用写入失败（%s）；可稍后用 fail_soft_set_enabled(true) 手动开启', switchBootstrap.error)
  }

  // ═══ 内核补丁自愈（跟随 DSH 官方更新）═══
  // 后台执行，不阻塞启动；发现补丁丢失（npx 重装/官方更新）时自动重打，
  // 官方版本与模板不一致（更旧或更新）时自动三路合并适配（0.1.14），
  // 冲突才降级——绝不破坏文件。
  let patchHealth = { status: 'checking', message: '正在检测内核补丁状态…' }
  import('./heal.js').then(({ heal }) => heal()).then((report) => {
    patchHealth = report
    if (report.status === 'repaired') {
      ctx.logger?.warn?.('[@lanbaolu/dsh-fail-soft] 内核补丁已自动修复（%s）——重启 dsh web 后挂载期 fail-soft 生效', report.applied?.join(', ') || report.message)
    } else if (report.status === 'needs-adaptation' || report.status === 'rolled-back') {
      ctx.logger?.warn?.('[@lanbaolu/dsh-fail-soft] 内核补丁未生效：%s', report.error || report.message)
    }
  }).catch((error) => {
    patchHealth = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  })

  // ═══ failSoft 服务 ═══
  const failSoft = {
    /** 是否启用（环境变量 DSH_FAIL_SOFT 或持久化开关，与内核 isFailSoft 一致）。 */
    enabled: () => {
      const v = process.env.DSH_FAIL_SOFT ?? ''
      return v === '1' || v === 'true' || v === 'yes' || v === 'on' || readFailSoftSwitch()
    },
    /** 内核补丁健康状态（heal 自检结果）。 */
    patchHealth: () => patchHealth,
    /** 被隔离（disabled + 隔离标记）的插件列表。 */
    listQuarantined() {
      const { file, entries } = readPatchEntries(profileDir)
      return {
        profileDir,
        file,
        quarantined: entries.filter((entry) => entry.quarantined),
        allDisabled: entries.filter((entry) => entry.disabled),
      }
    },
    /** 恢复一个被隔离的插件（删除 patch 条目）。 */
    restore(id) {
      const result = removePatchEntry(profileDir, id)
      if (result.ok) ctx.logger?.info?.('[@lanbaolu/dsh-fail-soft] restored plugin entry %s', id)
      return result
    },
    /** 手动隔离一个插件。 */
    quarantine(id, name, reason) {
      const result = quarantinePlugin(profileDir, id, name ?? id, reason)
      if (result.ok) ctx.logger?.info?.('[@lanbaolu/dsh-fail-soft] quarantined plugin %s (%s)', id, name ?? id)
      return result
    },
    /** 设置持久化开关（内核补丁启动时读取，App/终端用户都无需设环境变量）。 */
    setEnabled(enabled) {
      try {
        const result = writeFailSoftSwitch(enabled)
        ctx.logger?.info?.('[@lanbaolu/dsh-fail-soft] 持久化开关已设为 %s（重启 dsh 后生效，文件: %s）', !!enabled, result.file)
        return result
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    status() {
      const list = failSoft.listQuarantined()
      return {
        enabled: failSoft.enabled(),
        switchEnabled: readFailSoftSwitch(),
        quarantinedCount: list.quarantined.length,
        quarantined: list.quarantined.map((entry) => ({ id: entry.id, reason: entry.reason })),
        disabledCount: list.allDisabled.length,
        profileDir: list.profileDir,
        patchFile: list.file,
        patch: patchHealth,
      }
    },
    /** 修复引擎（方案②）：补丁失效时自动重打/回滚 + profile patch 去重。 */
    async repair() {
      try {
        const { repairPatch, detectActiveInstall } = await import('./heal.js')
        const installDir = detectActiveInstall()
        // 集成 dsh-fix（dev_fix_patch）：先修重复 entry id（会导致启动崩溃）
        const patchFix = profileDir ? fixDuplicatePatchIds(profileDir) : { ok: false, error: '无 profile 目录' }
        // 补丁失效备用方案：needs-apply→重打；needs-adaptation→自动回滚
        const report = installDir ? await repairPatch(installDir) : null
        ctx.logger?.info?.('[@lanbaolu/dsh-fail-soft] repair 完成: patchFix.removed=%s patch=%s', patchFix.removed ?? '?', report?.status ?? '无安装')
        return { ok: true, patchFix, patch: report }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
  }
  ctx.provide('failSoft', failSoft)

  // ═══ 运行期工具 / HTTP API（延迟到服务就绪后注册）═══
  // 本插件不声明硬 inject（tools/webServer 仅在可用时增强），而 Cordis 的
  // bundle 装配可能在 tools/webServer 服务就绪前 apply —— 若立即注册会漏注册，
  // 表现为重启后 fail_soft_* 工具不可用、/api/fail-soft/* 404。
  // 这里先尝试注册，未就绪则监听 internal/service，等对应服务出现后再补注册，
  // 保证任何启动时序下运行期管理面都生效。
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
  let toolsRegistered = false
  let webServerRegistered = false
  let toolsUnavailableWarned = false
  const registerIfReady = async () => {
    const tools = ctx.get('tools')
    const webServer = ctx.get('webServer')
    if (tools && !toolsRegistered) {
      const defineTool = await loadDefineTool()
      if (!defineTool) {
        // peer 解析失败不再弄崩激活（0.1.14 修复①）：只跳过工具注册，
        // failSoft 服务 / HTTP API / client 面板照常。
        if (!toolsUnavailableWarned) {
          toolsUnavailableWarned = true
          ctx.logger?.warn?.('[@lanbaolu/dsh-fail-soft] 无法解析 @deepseek-ai/dsh-tools，跳过 fail_soft_* 工具注册（管理 API / UI 面板不受影响）')
        }
      } else {
      toolsRegistered = true
      ctx.effect(() => tools.register(defineTool({
        name: 'fail_soft_status',
        description: '查询 DSH 插件错误隔离（fail-soft）状态：是否启用、当前被隔离的插件列表。',
        parameters: {},
        output: textOutput,
        async execute() {
          return JSON.stringify(failSoft.status(), null, 2)
        },
      })), '@lanbaolu/dsh-fail-soft: status tool')

      ctx.effect(() => tools.register(defineTool({
        name: 'fail_soft_list',
        description: '列出被 @lanbaolu/dsh-fail-soft 自动隔离的插件（含隔离原因）与 patch 文件中所有 disabled 条目。',
        parameters: {},
        output: textOutput,
        async execute() {
          return JSON.stringify(failSoft.listQuarantined(), null, 2)
        },
      })), '@lanbaolu/dsh-fail-soft: list tool')

      ctx.effect(() => tools.register(defineTool({
        name: 'fail_soft_restore',
        description: '恢复一个被 @lanbaolu/dsh-fail-soft 隔离的插件：删除其在 profile cordis.patch.yml 中的 disabled 条目（只允许删除带隔离标记的条目），重启后插件重新装配。',
        parameters: {
          id: { type: 'string', required: true, description: '被隔离插件的 entry id（如 bad-plugin）' },
        },
        output: textOutput,
        async execute(args) {
          return JSON.stringify(failSoft.restore(args.id), null, 2)
        },
      })), '@lanbaolu/dsh-fail-soft: restore tool')

      ctx.effect(() => tools.register(defineTool({
        name: 'fail_soft_quarantine',
        description: '手动隔离一个插件：向 profile cordis.patch.yml 写入 disabled 条目（带隔离标记），下次启动跳过该插件。',
        parameters: {
          id: { type: 'string', required: true, description: '插件的 entry id（如 bad-plugin）' },
          name: { type: 'string', description: '包名（可选，用于诊断）' },
          reason: { type: 'string', description: '隔离原因（可选）' },
        },
        output: textOutput,
        async execute(args) {
          return JSON.stringify(failSoft.quarantine(args.id, args.name, args.reason), null, 2)
        },
      })), '@lanbaolu/dsh-fail-soft: quarantine tool')

      ctx.effect(() => tools.register(defineTool({
        name: 'fail_soft_set_enabled',
        description: '设置 fail-soft 持久化开关（写 ~/.dsh/fail-soft.json，内核补丁启动时读取）：true=启用挂载兜底，false=关闭。App/终端用户都无需手动设置 DSH_FAIL_SOFT 环境变量，重启 dsh 后生效。',
        parameters: {
          enabled: { type: 'boolean', required: true, description: 'true=开启 fail-soft（重启后生效），false=关闭' },
        },
        output: textOutput,
        async execute(args) {
          return JSON.stringify(failSoft.setEnabled(args.enabled), null, 2)
        },
      })), '@lanbaolu/dsh-fail-soft: set-enabled tool')

      ctx.effect(() => tools.register(defineTool({
        name: 'fail_soft_repair',
        description: '修复 fail-soft 内核补丁（方案②修复引擎）：补丁丢失自动重打；官方改结构自动回滚到官方原版（挂载兜底不生效但服务能起）并给适配指引。',
        parameters: {},
        output: textOutput,
        async execute() {
          return JSON.stringify(await failSoft.repair(), null, 2)
        },
      })), '@lanbaolu/dsh-fail-soft: repair tool')
      }
    }
    if (webServer && !webServerRegistered) {
      webServerRegistered = true
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/fail-soft',
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://localhost')
          const path = url.pathname
          const send = (code, data) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(data))
          }
          try {
            if (req.method === 'GET' && (path === '/api/fail-soft/status' || path === '/api/fail-soft')) {
              send(200, failSoft.status())
            } else if (req.method === 'GET' && path === '/api/fail-soft/list') {
              send(200, failSoft.listQuarantined())
            } else if (req.method === 'POST' && path === '/api/fail-soft/restore') {
              let body = ''
              for await (const chunk of req) body += chunk
              const parsed = JSON.parse(body || '{}')
              send(200, failSoft.restore(parsed.id))
            } else if (req.method === 'POST' && path === '/api/fail-soft/quarantine') {
              let body = ''
              for await (const chunk of req) body += chunk
              const parsed = JSON.parse(body || '{}')
              send(200, failSoft.quarantine(parsed.id, parsed.name, parsed.reason))
            } else if (req.method === 'POST' && path === '/api/fail-soft/set-enabled') {
              let body = ''
              for await (const chunk of req) body += chunk
              const parsed = JSON.parse(body || '{}')
              send(200, failSoft.setEnabled(parsed.enabled === true))
            } else if (req.method === 'POST' && path === '/api/fail-soft/repair') {
              send(200, await failSoft.repair())
            } else {
              send(404, { ok: false, error: 'not found' })
            }
          } catch (error) {
            send(500, { ok: false, error: String(error) })
          }
        },
      }), '@lanbaolu/dsh-fail-soft: api')
    }
    if (toolsRegistered || webServerRegistered) {
      ctx.logger?.info?.('[@lanbaolu/dsh-fail-soft] 运行期管理面已注册（tools=%s webServer=%s）', toolsRegistered, webServerRegistered)
    }
  }
  void registerIfReady()
  if (!toolsRegistered || !webServerRegistered) {
    ctx.on('internal/service', (name) => {
      if (name === 'tools' || name === 'webServer') void registerIfReady()
    })
  }

  ctx.logger?.info?.('[@lanbaolu/dsh-fail-soft] 就绪：fail-soft %s（profile: %s）', failSoft.enabled() ? '已启用' : '未启用（设置 DSH_FAIL_SOFT=1）', profileDir ?? '?')
}
