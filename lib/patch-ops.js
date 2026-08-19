/**
 * @lanbaolu/dsh-fail-soft — profile patch 文件操作（隔离/解析/恢复）。
 * 零 DSH 依赖（仅 node:fs / node:path），供 lib/index.js 与测试 / doctor 共用。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergePatchBlock, backupPatchFile } from './mount-core.js'

/** 隔离注释标记（与 lib/mount-core.js 保持一致）。 */
export const QUARANTINE_MARKER = '@lanbaolu/dsh-fail-soft'

function patchFilePath(profileDir) {
  return join(profileDir, 'cordis.patch.yml')
}

/**
 * 解析 profile 的 cordis.patch.yml：返回行级条目
 * `{ id, disabled, quarantined, reason, lineNo }`。quarantined=true 表示该
 * 条目带 @lanbaolu/dsh-fail-soft 隔离注释（自动隔离写入的）。
 */
export function readPatchEntries(profileDir) {
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
export function removePatchEntry(profileDir, id) {
  const { file, entries } = readPatchEntries(profileDir)
  if (!file) return { ok: false, error: 'profile patch 文件不存在' }
  const target = entries.find((entry) => entry.id === id)
  if (!target) return { ok: false, error: `未找到 entry "${id}"` }
  if (!target.quarantined) return { ok: false, error: `entry "${id}" 不是 @lanbaolu/dsh-fail-soft 隔离的（无隔离标记），拒绝自动删除` }
  const lines = readFileSync(file, 'utf8').split('\n')
  // 删除目标条目：向上吸收其上面的隔离注释（连续 # 行）
  const removeFrom = target.lineNo - 1
  let commentStart = removeFrom
  while (commentStart > 0) {
    const prev = lines[commentStart - 1]
    if (/^\s*#/.test(prev)) commentStart--
    else break
  }
  // 完整块 = 注释 + id 行 + 该 entry 的缩进属性行（target.lines 已收集）
  const blockEnd = (target.lineNo - 1) + target.lines.length
  // 吸收块后的空行，避免留下孤立空行
  let end = blockEnd
  while (end < lines.length && lines[end].trim() === '') end++
  const removedLines = lines.slice(commentStart, blockEnd)
  const kept = [...lines.slice(0, commentStart), ...lines.slice(end)]
  backupPatchFile(profileDir) // 配置层防御：写前自动备份
  writeFileSync(file, kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
  return { ok: true, removed: removedLines }
}

/** 手动隔离一个插件（写 disabled patch，带隔离标记）。 */
export function quarantinePlugin(profileDir, id, name, reason) {
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
    // 用 mergePatchBlock 合并：正文是空数组 `[]`（DSH 默认形态）时**替换**
    // 而非追加，避免 `[]` + `- id:` 两个文档混排导致 YAML 解析崩溃。
    backupPatchFile(profileDir) // 配置层防御：写前自动备份
    writeFileSync(file, mergePatchBlock(body, block))
  } catch (error) {
    return { ok: false, error: `写入 ${file} 失败: ${String(error)}` }
  }
  return { ok: true, id }
}
