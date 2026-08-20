/**
 * @lanbaolu/dsh-fail-soft — 自适应补丁引擎（方案③，阶段一）。
 *
 * 思路：DSH 官方升级时，backup 里的 orig/patched 是旧版模板；官方新版相对
 * orig 的差异（通常是小段新增，如 rc.8 加一行 `"BROWSER"`）自动**合并进
 * patched**，生成新版补丁模板——这样补丁自动跟上 DSH 版本，不再等手工更新。
 *
 * 阶段一支持"纯新增行"差异（官方插入若干行）；若官方删除/修改了已有行
 * （结构大改），报需人工适配。
 *
 * 本模块零 DSH 依赖、纯函数可测。
 */

/**
 * 找出 `official` 相对 `orig` 的**纯新增行块**（在 orig 中不存在的连续行）。
 * @param {string[]} origLines 旧版官方源码行
 * @param {string[]} officialLines 新版官方源码行
 * @returns {Array<{block: string[], afterLine: string|null, beforeLine: string|null}>}
 */
export function lineDiffInsertions(origLines, officialLines) {
  const origSet = new Set(origLines)
  const insertions = []
  let i = 0
  while (i < officialLines.length) {
    if (origSet.has(officialLines[i])) {
      i++
      continue
    }
    const block = []
    const start = i
    while (i < officialLines.length && !origSet.has(officialLines[i])) {
      block.push(officialLines[i])
      i++
    }
    insertions.push({
      block,
      afterLine: start > 0 ? officialLines[start - 1] : null,
      beforeLine: i < officialLines.length ? officialLines[i] : null,
    })
  }
  return insertions
}

/**
 * 把新增行块合并进 patched 源码（按 afterLine/beforeLine 锚点定位插入）。
 * @returns {{ok: boolean, source?: string, error?: string}}
 */
export function mergeInsertionsIntoPatched(patchedSrc, insertions) {
  let lines = patchedSrc.split('\n')
  let inserted = 0
  for (const ins of insertions) {
    const blockText = ins.block.join('\n')
    if (lines.join('\n').includes(blockText)) continue // 已包含（幂等）
    if (ins.afterLine !== null) {
      const idx = lines.findIndex((l) => l === ins.afterLine)
      if (idx >= 0) {
        lines.splice(idx + 1, 0, ...ins.block)
        inserted++
        continue
      }
    }
    if (ins.beforeLine !== null) {
      const idx = lines.findIndex((l) => l === ins.beforeLine)
      if (idx >= 0) {
        lines.splice(idx, 0, ...ins.block)
        inserted++
        continue
      }
    }
    return { ok: false, error: `无法在 patched 中定位插入锚点: ${blockText.slice(0, 60)}` }
  }
  return { ok: true, source: lines.join('\n'), inserted }
}

/**
 * 自适应合并：用旧版模板（orig/patched）+ 官方新版源码，生成新版 patched。
 * @param {string} origSrc 旧版官方源码（backup/*.orig）
 * @param {string} patchedSrc 旧版补丁源码（backup/*.patched）
 * @param {string} officialSrc 当前官方（未打补丁）源码
 * @returns {{ok: boolean, source?: string, applied: string[], error?: string, note?: string}}
 */
export function adaptPatchedTemplate(origSrc, patchedSrc, officialSrc) {
  if (officialSrc === origSrc) {
    return { ok: true, source: patchedSrc, applied: [], note: '官方未变化，模板无需适配' }
  }
  const origLines = origSrc.split('\n')
  const officialLines = officialSrc.split('\n')
  // 检测删除/修改行：官方不再包含 orig 的某行 → 非纯新增，不能安全合并
  const officialSet = new Set(officialLines)
  const deleted = origLines.filter((line) => !officialSet.has(line))
  if (deleted.length > 0) {
    return { ok: false, applied: [], error: `官方改动含删除/修改行（如 ${deleted[0].slice(0, 60)}），非纯新增，暂需人工适配 backup/ 模板` }
  }
  const insertions = lineDiffInsertions(origLines, officialLines)
  if (insertions.length === 0) {
    return { ok: false, applied: [], error: '官方改动不是纯新增行（含删除/修改），暂需人工适配 backup/ 模板' }
  }
  const merged = mergeInsertionsIntoPatched(patchedSrc, insertions)
  if (!merged.ok) return { ok: false, applied: [], error: merged.error }
  return {
    ok: true,
    source: merged.source,
    applied: insertions.slice(0, merged.inserted).map((ins) => ins.block[0]?.slice(0, 60) ?? ''),
    note: `已将 ${merged.inserted} 个官方新增行块合并进补丁模板`,
  }
}
