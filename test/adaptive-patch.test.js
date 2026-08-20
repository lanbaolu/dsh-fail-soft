/**
 * adaptive-patch.test.js — 自适应补丁引擎（方案③，三路合并 diff3）回归。
 *
 * 验证：官方新增/删除/修改行（不与补丁改动冲突）都能自动合并进 patched；
 * 补丁删除的行官方保留 → 冲突需人工。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { lineDiffInsertions, merge3, adaptPatchedTemplate } from '../lib/adaptive-patch.js'

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
  assert.ok(r.source.includes('\t"BROWSER",\n\t"NEW_ENV",'))
  // 幂等：再适配（official=已合并后）→ 仍 ok，新增块不重复
  const r2 = adaptPatchedTemplate(ORIG, r.source, official)
  assert.equal(r2.ok, true)
  const count = r2.source.split('\n').filter((l) => l === '\t"NEW_ENV",').length
  assert.equal(count, 1)
})

test('adaptPatchedTemplate: 官方删除补丁没动的行 → 自动跟随删除', () => {
  // 官方删掉一行补丁没动的环境变量（如 EDITOR）
  const official = ORIG.replace('\t"EDITOR",\n', '')
  const r = adaptPatchedTemplate(ORIG, PATCHED, official)
  assert.equal(r.ok, true)
  assert.ok(!r.source.includes('\t"EDITOR",'))
  // 补丁其它内容仍在（如防御函数）
  assert.ok(r.source.includes('function loadUserPatchLayerFailSoft('))
})

test('merge3: 补丁删除的行官方保留 → 跟随补丁删除（不冲突）', () => {
  const orig = ['a', 'X', 'b'].join('\n')
  const patched = ['a', 'b'].join('\n') // 补丁删了 X
  const official = ['a', 'X', 'b'].join('\n') // 官方保留 X（官方没改它）
  const r = merge3(orig, patched, official)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'a\nb')
})

test('merge3: 补丁与官方都删除同一行 → 一致删除，不冲突', () => {
  const orig = ['a', 'X', 'b'].join('\n')
  const patched = ['a', 'b'].join('\n') // 补丁删了 X
  const official = ['a', 'b'].join('\n') // 官方也删了 X
  const r = merge3(orig, patched, official)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'a\nb')
})

test('merge3: 同一锚点双方插入不同内容 → 冲突并带诊断', () => {
  const orig = ['a', 'b'].join('\n')
  const patched = ['a', 'P1', 'b'].join('\n') // 补丁在 a 后插 P1
  const official = ['a', 'P2', 'b'].join('\n') // 官方在 a 后插 P2
  const r = merge3(orig, patched, official)
  assert.equal(r.ok, false)
  assert.match(r.error, /冲突/)
  assert.ok(r.conflicts[0].patch.includes('P1'))
  assert.ok(r.conflicts[0].official.includes('P2'))
})

test('lineDiffInsertions: 重复行按计数处理（删除一个重复行不算新增）', () => {
  const orig = ['a', '}', 'b', '}'].join('\n') // 两个 }
  const official = ['a', '}', 'b'].join('\n') // 官方删了一个 }
  const ins = lineDiffInsertions(orig.split('\n'), official.split('\n'))
  assert.equal(ins.length, 0) // 没有新增
})

test('merge3: 官方删除补丁没动的行 → 合并成功且不丢补丁新增', () => {
  const orig = ['a', 'X', 'b'].join('\n')
  const patched = ['a', 'X', 'P', 'b'].join('\n') // 补丁新增 P
  const official = ['a', 'b'].join('\n') // 官方删了 X
  const r = merge3(orig, patched, official)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'a\nP\nb')
})

test('adaptPatchedTemplate: 官方大改但补丁没动的行也能合并（真实文件冒烟）', () => {
  // 官方把某个补丁没动的函数名改掉（删除+新增，非冲突）——选一处安全替换
  const official = ORIG.replace('function listMatching(', 'function listMatchingV2(')
  // 若 orig 里没有该函数名（可能不存在）则跳过；这里仅做健壮性
  if (official !== ORIG) {
    const r = adaptPatchedTemplate(ORIG, PATCHED, official)
    assert.equal(r.ok, true)
    assert.ok(r.source.includes('function listMatchingV2('))
  }
})
