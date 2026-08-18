/**
 * @dsh-external/dsh-fail-soft — 插件错误自动隔离。
 *
 * 两个组成部分：
 *  1. mount 兜底（lib/mount.js）：被 DSH 内核在 include 树挂载前动态加载，
 *     坏插件 → 自动隔离（写 disabled patch）→ 剔除重试挂载 → 服务照常起。
 *  2. 本模块（cordis 插件入口）：运行期管理——隔离列表查询、恢复、手动
 *     隔离（failSoft 服务 + fail_soft_* 工具 + /api/fail-soft/* HTTP API +
 *     client 面板）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '@dsh-external/dsh-fail-soft'
// 不声明硬 inject：tools/webServer 仅在可用时增强（缺 base 的 profile 里
// 本插件照常激活，failSoft 服务始终可用）。

/** 隔离注释标记（与 lib/mount.js 保持一致）。 */
const QUARANTINE_MARKER = 'dsh-fail-soft'

function profileDirOf(ctx) {
  try {
    if (!ctx.baseUrl) return undefined
    const path = fileURLToPath(ctx.baseUrl)
    // ctx.baseUrl 以 '/' 结尾（目录 URL），去掉尾斜杠即目录本身
    return path.endsWith('/') ? path.slice(0, -1) : dirname(path)
  } catch {
    return undefined
  }
}

function patchFilePath(profileDir) {
  return join(profileDir, 'cordis.patch.yml')
}

/**
 * 解析 profile 的 cordis.patch.yml：返回行级条目
 * `{ id, disabled, quarantined, reason, lineNo }`。quarantined=true 表示该
 * 条目带 dsh-fail-soft 隔离注释（自动隔离写入的）。
 */
function readPatchEntries(profileDir) {
  if (!profileDir) return { file: undefined, entries: [] }
  const file = patchFilePath(profileDir)
  if (!existsSync(file)) return { file, entries: [] }
  let lines
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {
    return { file, entries: [] }
  }
  const entries = []
  let current = null
  let pendingComment = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const commentMatch = /^\s*#\s*quarantined by\s+([^\s:]+)[:\s-]*\s*(.*)$/.exec(line)
    if (commentMatch && commentMatch[1] === QUARANTINE_MARKER) {
      pendingComment = commentMatch[2] ?? ''
      continue
    }
    const entryMatch = /^\s*-\s*id:\s*([^\s#]+)/.exec(line)
    if (entryMatch) {
      current = {
        id: entryMatch[1],
        disabled: false,
        quarantined: pendingComment !== null,
        reason: pendingComment ?? '',
        lineNo: i + 1,
        lines: [line],
      }
      pendingComment = null
      entries.push(current)
      continue
    }
    if (current) {
      const keyMatch = /^\s+(\w+):\s*(.*)$/.exec(line)
      if (keyMatch) {
        if (keyMatch[1] === 'disabled') current.disabled = keyMatch[2].trim() === 'true'
        current.lines.push(line)
      } else if (/^\s*-\s*id:/.test(line) === false && /^\s*-/.test(line) === false) {
        current.lines.push(line)
      } else {
        current = null
      }
    }
  }
  return { file, entries }
}

/** 删除指定 id 的隔离条目（连同其 quarantine 注释），返回是否删掉。 */
function removePatchEntry(profileDir, id) {
  const { file, entries } = readPatchEntries(profileDir)
  if (!file) return { ok: false, error: 'profile patch 文件不存在' }
  const target = entries.find((entry) => entry.id === id)
  if (!target) return { ok: false, error: `未找到 entry "${id}"` }
  if (!target.quarantined) return { ok: false, error: `entry "${id}" 不是 dsh-fail-soft 隔离的（无隔离标记），拒绝自动删除` }
  const lines = readFileSync(file, 'utf8').split('\n')
  // 删除目标条目：向上吸收其上面的隔离注释（连续 # 行），跳过空行
  const removeFrom = target.lineNo - 1
  let commentStart = removeFrom
  while (commentStart > 0) {
    const prev = lines[commentStart - 1]
    if (/^\s*#/.test(prev)) commentStart--
    else break
  }
  const removedLines = lines.slice(commentStart, target.lineNo)
  const nextNonEmpty = (() => {
    let i = target.lineNo
    while (i < lines.length && lines[i].trim() === '') i++
    return i
  })()
  const tail = nextNonEmpty <= target.lineNo ? [] : lines.slice(nextNonEmpty)
  const kept = [...lines.slice(0, commentStart), ...tail]
  writeFileSync(file, kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
  return { ok: true, removed: removedLines }
}

/** 手动隔离一个插件（写 disabled patch，带隔离标记）。 */
function quarantinePlugin(profileDir, id, name, reason) {
  if (!profileDir) return { ok: false, error: '无法定位 profile 目录' }
  const file = patchFilePath(profileDir)
  let body = ''
  try {
    body = existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch (error) {
    return { ok: false, error: `读取 ${file} 失败: ${String(error)}` }
  }
  const existing = /^\s*-\s*id:\s*([^\s#]+)/gm
  let match
  while ((match = existing.exec(body))) {
    if (match[1] === id) return { ok: false, error: `entry "${id}" 已存在于 patch 文件` }
  }
  const stamp = new Date().toISOString()
  const block = `# quarantined by ${QUARANTINE_MARKER} at ${stamp} — ${id}: ${name} — ${reason ?? 'manual'}\n- id: ${id}\n  disabled: true\n`
  try {
    writeFileSync(file, body.length === 0 || body.endsWith('\n') ? body + block : body + '\n' + block)
  } catch (error) {
    return { ok: false, error: `写入 ${file} 失败: ${String(error)}` }
  }
  return { ok: true, id }
}

export function apply(ctx) {
  const profileDir = profileDirOf(ctx)
  const tools = ctx.get('tools')
  const webServer = ctx.get('webServer')

  // ═══ failSoft 服务 ═══
  const failSoft = {
    /** 是否启用（进程环境变量 DSH_FAIL_SOFT）。 */
    enabled: () => {
      const v = process.env.DSH_FAIL_SOFT ?? ''
      return v === '1' || v === 'true' || v === 'yes' || v === 'on'
    },
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
      if (result.ok) ctx.logger?.info?.('[dsh-fail-soft] restored plugin entry %s', id)
      return result
    },
    /** 手动隔离一个插件。 */
    quarantine(id, name, reason) {
      const result = quarantinePlugin(profileDir, id, name ?? id, reason)
      if (result.ok) ctx.logger?.info?.('[dsh-fail-soft] quarantined plugin %s (%s)', id, name ?? id)
      return result
    },
    status() {
      const list = failSoft.listQuarantined()
      return {
        enabled: failSoft.enabled(),
        quarantinedCount: list.quarantined.length,
        quarantined: list.quarantined.map((entry) => ({ id: entry.id, reason: entry.reason })),
        disabledCount: list.allDisabled.length,
        profileDir: list.profileDir,
        patchFile: list.file,
      }
    },
  }
  ctx.provide('failSoft', failSoft)

  // ═══ 工具（模型可直接调用）═══
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
  tools && ctx.effect(() => tools.register(defineTool({
    name: 'fail_soft_status',
    description: '查询 DSH 插件错误隔离（fail-soft）状态：是否启用、当前被隔离的插件列表。',
    parameters: {},
    output: textOutput,
    async execute() {
      return JSON.stringify(failSoft.status(), null, 2)
    },
  })), 'dsh-fail-soft: status tool')

  tools && ctx.effect(() => tools.register(defineTool({
    name: 'fail_soft_list',
    description: '列出被 dsh-fail-soft 自动隔离的插件（含隔离原因）与 patch 文件中所有 disabled 条目。',
    parameters: {},
    output: textOutput,
    async execute() {
      return JSON.stringify(failSoft.listQuarantined(), null, 2)
    },
  })), 'dsh-fail-soft: list tool')

  tools && ctx.effect(() => tools.register(defineTool({
    name: 'fail_soft_restore',
    description: '恢复一个被 dsh-fail-soft 隔离的插件：删除其在 profile cordis.patch.yml 中的 disabled 条目（只允许删除带隔离标记的条目），重启后插件重新装配。',
    parameters: {
      id: { type: 'string', required: true, description: '被隔离插件的 entry id（如 bad-plugin）' },
    },
    output: textOutput,
    async execute(args) {
      return JSON.stringify(failSoft.restore(args.id), null, 2)
    },
  })), 'dsh-fail-soft: restore tool')

  tools && ctx.effect(() => tools.register(defineTool({
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
  })), 'dsh-fail-soft: quarantine tool')

  // ═══ HTTP API（client 面板消费）═══
  webServer && ctx.effect(() => webServer.register({
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
        } else {
          send(404, { ok: false, error: 'not found' })
        }
      } catch (error) {
        send(500, { ok: false, error: String(error) })
      }
    },
  }), 'dsh-fail-soft: api')

  ctx.logger?.info?.('[dsh-fail-soft] 就绪：fail-soft %s（profile: %s）', failSoft.enabled() ? '已启用' : '未启用（设置 DSH_FAIL_SOFT=1）', profileDir ?? '?')
}
