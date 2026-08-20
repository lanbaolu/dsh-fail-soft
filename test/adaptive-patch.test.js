/**
 * adaptive-patch.test.js — 自适应补丁引擎（方案③）回归。
 *
 * 验证：官方新版相对 backup orig 的纯新增行，能自动合并进 backup patched
 * 生成新版补丁模板（如 rc.8 加一行 "BROWSER"）；非纯新增（删除/修改）报需人工。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { lineDiffInsertions, mergeInsertionsIntoPatched, adaptPatchedTemplate } from '../lib/adaptive-patch.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORIG = readFileSync(join(ROOT, 'backup', 'dsh-app-boot.index.js.orig'), 'utf8')
const PATCHED = readFileSync(join(ROOT, 'backup', 'dsh-app-boot.index.js.patched'), 'utf8')

test('lineDiffInsertions: 识别纯新增行块并带上下文锚点', () => {
  const orig = ['a', 'b', 'c'].join('\n')
  const official = ['a', 'X', 'Y', 'b', 'c'].join('\n')
  const ins = lineDiffInsertions(orig.split('\n'), official.split('\n'))
  assert.equal(ins.length, 1)
  assert.deepEqual(ins[0].block, ['X', 'Y'])
  assert.equal(ins[0].afterLine, 'a')
  assert.equal(ins[0].beforeLine, 'b')
})

test('adaptPatchedTemplate: 官方新增行自动合并进 patched（幂等）', () => {
  // 模拟官方 rc.9 在 "BROWSER" 后新增一行 "NEW_ENV"
  const official = ORIG.replace('\t"BROWSER",', '\t"BROWSER",\n\t"NEW_ENV",')
  const r = adaptPatchedTemplate(ORIG, PATCHED, official)
  assert.equal(r.ok, true)
  assert.ok(r.source.includes('\t"NEW_ENV",'))
  // 合并位置正确（BROWSER 后）
  assert.ok(r.source.includes('\t"BROWSER",\n\t"NEW_ENV",'))
  // 再次适配（官方=已合并后）→ 幂等无新增
  const r2 = adaptPatchedTemplate(ORIG, r.source, official)
  assert.equal(r2.ok, true)
  assert.equal(r2.applied.length, 0)
})

test('adaptPatchedTemplate: 官方删除/修改行（非纯新增）→ 需人工', () => {
  const official = ORIG.replace('\t"PAGER",', '\t"PAGER_V2",')
  const r = adaptPatchedTemplate(ORIG, PATCHED, official)
  assert.equal(r.ok, false)
  assert.match(r.error, /非纯新增/)
})

test('mergeInsertionsIntoPatched: 找不到锚点报错', () => {
  const r = mergeInsertionsIntoPatched('a\nb\n', [{ block: ['X'], afterLine: 'zzz', beforeLine: null }])
  assert.equal(r.ok, false)
  assert.match(r.error, /无法在 patched 中定位/)
})
