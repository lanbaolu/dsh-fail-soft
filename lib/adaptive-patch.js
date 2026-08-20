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
  const merged = merge3(origSrc, patchedSrc, officialSrc)
  if (!merged.ok) {
    return { ok: false, applied: [], error: merged.error, conflicts: merged.conflicts }
  }
  return {
    ok: true,
    source: merged.source,
    applied: merged.applied,
    note: `三路合并成功：已把官方改动合并进补丁模板（${merged.applied.length} 个变更块）`,
  }
}

/**
 * LCS 回溯：标记 `a` 中哪些行按顺序保留在 `b` 中（diff 的 retained 数组）。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean[]} 长度 = a.length
 */
function lcsRetained(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const retained = new Array(n).fill(false)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      retained[i] = true
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return retained
}

/**
 * 三路合并（diff3，方案③阶段二核心）：
 * - orig = 官方旧版（backup/*.orig）
 * - patched = 旧版补丁（backup/*.patched）
 * - official = 官方新版（当前未打补丁）
 *
 * 规则：
 * - orig 行补丁删了、官方也删了 → 删除（一致）
 * - orig 行补丁删了、官方保留 → 冲突（补丁与官方改了同一行）
 * - orig 行补丁保留、官方删了 → 跟随官方删除（补丁没动那行）
 * - orig 行双方保留 → 输出
 * - patched/official 相对 orig 的新增行块 → 按上下文插入
 * - 任何新增块在结果中丢失（锚点被对方改动破坏）→ 报需人工（保守）
 * @returns {{ok: boolean, source?: string, applied?: string[], error?: string, conflicts?: Array<{line: number, text: string}>}}
 */
export function merge3(origSrc, patchedSrc, officialSrc) {
  const origLines = origSrc.split('\n')
  const patchLines = patchedSrc.split('\n')
  const officialLines = officialSrc.split('\n')
  const inPatch = lcsRetained(origLines, patchLines)
  const inOfficial = lcsRetained(origLines, officialLines)

  // 1) 冲突检测：
  //    - orig 行补丁和官方**都删除** → 双方改了同一行 → 冲突
  //    - 补丁删 + 官方保留（或反之）→ 不冲突，跟随删除方
  //    - 同一锚点（afterLine）双方都插入 → 顺序不明 → 冲突（保守）
  const conflicts = []
  for (let i = 0; i < origLines.length; i++) {
    if (!inPatch[i] && !inOfficial[i]) {
      conflicts.push({ line: i + 1, text: origLines[i].slice(0, 80), reason: '补丁与官方都删除了该行（双方改动冲突）' })
    }
  }

  // 2) 新增行块（相对 orig）
  const patchIns = lineDiffInsertions(origLines, patchLines)
  const officialIns = lineDiffInsertions(origLines, officialLines)
  const patchAfterSet = new Set(patchIns.filter((b) => b.afterLine !== null).map((b) => b.afterLine))
  const officialAfterSet = new Set(officialIns.filter((b) => b.afterLine !== null).map((b) => b.afterLine))
  for (const anchor of patchAfterSet) {
    if (officialAfterSet.has(anchor)) {
      const patchText = patchIns.filter((b) => b.afterLine === anchor).flatMap((b) => b.block).join('\n')
      const officialText = officialIns.filter((b) => b.afterLine === anchor).flatMap((b) => b.block).join('\n')
      if (patchText !== officialText) {
        conflicts.push({ line: Math.max(0, origLines.indexOf(anchor)) + 1, text: anchor.slice(0, 80), reason: '补丁与官方都在同一行后插入不同内容（双方改动冲突）' })
      }
      // 相同内容 → 幂等，不冲突
    }
  }
  if (conflicts.length > 0) {
    return { ok: false, conflicts, error: `三路合并冲突 ${conflicts.length} 处（补丁与官方改动同一区域），需人工适配` }
  }

  // 3) 生成合并结果：只有双方都保留的 orig 行输出（任一方删除则不输出），
  //    新增块按锚点插入；相同内容块去重（幂等）。
  const out = []
  const insertedBlocks = new Set()
  const pushBlocksAfter = (blocks, afterLine) => {
    for (const b of blocks) {
      if (b.afterLine !== afterLine) continue
      const text = b.block.join('\n')
      if (insertedBlocks.has(text)) continue
      insertedBlocks.add(text)
      out.push(...b.block)
    }
  }
  const pushBlocksBefore = (blocks, beforeLine) => {
    for (const b of blocks) {
      if (b.beforeLine !== beforeLine) continue
      const text = b.block.join('\n')
      if (insertedBlocks.has(text)) continue
      insertedBlocks.add(text)
      out.push(...b.block)
    }
  }
  // 头部新增（afterLine null）
  for (const b of [...patchIns, ...officialIns]) if (b.afterLine === null) out.push(...b.block)
  for (let i = 0; i < origLines.length; i++) {
    const line = origLines[i]
    pushBlocksBefore(patchIns, line)
    pushBlocksBefore(officialIns, line)
    if (inPatch[i] && inOfficial[i]) out.push(line)
    pushBlocksAfter(patchIns, line)
    pushBlocksAfter(officialIns, line)
  }
  // 尾部新增（beforeLine null）
  for (const b of [...patchIns, ...officialIns]) if (b.beforeLine === null) out.push(...b.block)

  // 4) 保守校验：任何新增块不得丢失（锚点被对方改动破坏时无法安全合并）
  const resultText = out.join('\n')
  const missingBlocks = []
  for (const b of patchIns) if (!resultText.includes(b.block.join('\n'))) missingBlocks.push(`补丁新增块丢失: ${b.block[0]?.slice(0, 60)}`)
  for (const b of officialIns) if (!resultText.includes(b.block.join('\n'))) missingBlocks.push(`官方新增块丢失: ${b.block[0]?.slice(0, 60)}`)
  if (missingBlocks.length > 0) {
    return { ok: false, conflicts: missingBlocks.map((reason) => ({ reason })), error: `三路合并无法安全应用（${missingBlocks.length} 个新增块锚点被对方改动破坏），需人工适配` }
  }

  return { ok: true, source: out.join('\n'), applied: [...patchIns, ...officialIns].map((b) => b.block[0]?.slice(0, 60) ?? '') }
}
