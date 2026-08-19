/**
 * mount-core.test.js — mount 兜底核心纯函数回归。
 * 覆盖：loader 失败收集（嵌套/去重/include 排除）、隔离写入（带标记/同 id 跳过）、
 * patch 栈剔除（filterQuarantinedPatches）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QUARANTINE_MARKER,
  collectLoaderEntryFailures,
  quarantineEntries,
  filterQuarantinedPatches,
  mergePatchBlock,
  PROFILE_PATCH_FILENAME,
} from '../lib/mount-core.js'

// ── collectLoaderEntryFailures ──

test('collectLoaderEntryFailures: 收集嵌套 AggregateError/cause 并去重', () => {
  const cause = new Error('failed to activate loader entry bad-a (pkg-a): boom')
  const inner = new AggregateError([cause], 'child')
  const outer = new AggregateError([inner], 'root')
  const found = collectLoaderEntryFailures(outer)
  assert.deepEqual(found, [{ id: 'bad-a', name: 'pkg-a' }])
})

test('collectLoaderEntryFailures: 多个失败 entry + 排除 include 根', () => {
  const err = new AggregateError([
    new Error('failed to load loader entry include (cordis:include): x'),
    new Error('failed to activate loader entry bad-a (pkg-a): boom'),
    new Error('failed to activate loader entry bad-b (pkg-b): boom'),
  ])
  const found = collectLoaderEntryFailures(err)
  assert.deepEqual(found, [
    { id: 'bad-a', name: 'pkg-a' },
    { id: 'bad-b', name: 'pkg-b' },
  ])
})

test('collectLoaderEntryFailures: 无 loader entry 信息返回空', () => {
  assert.deepEqual(collectLoaderEntryFailures(new Error('plain failure')), [])
  assert.deepEqual(collectLoaderEntryFailures(null), [])
  assert.deepEqual(collectLoaderEntryFailures('not an error'), [])
})

// ── quarantineEntries ──

function tmpProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'fail-soft-test-'))
  return dir
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('quarantineEntries: 无 patch 文件时创建并写入隔离条目（带标记 + disabled）', () => {
  const dir = tmpProfile()
  try {
    const written = quarantineEntries(dir, [{ id: 'bad-x', message: 'pkg-x: crashed on activate' }])
    assert.deepEqual(written, ['bad-x'])
    const body = readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')
    assert.match(body, new RegExp(`# quarantined by ${QUARANTINE_MARKER}`))
    assert.match(body, /- id: bad-x\n\s+disabled: true/)
  } finally {
    cleanup(dir)
  }
})

test('quarantineEntries: 同 id 已存在则跳过（避免 duplicate id 崩溃）', () => {
  const dir = tmpProfile()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '# head\n- id: good\n  disabled: false\n', 'utf8')
    const written = quarantineEntries(dir, [
      { id: 'good', message: 'existing' },
      { id: 'bad', message: 'new' },
    ])
    assert.deepEqual(written, ['bad'])
    const body = readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')
    assert.ok(body.includes('- id: bad'))
    assert.equal((body.match(/- id: good/g) || []).length, 1)
  } finally {
    cleanup(dir)
  }
})

test('quarantineEntries: 无有效 id 的 failure 被忽略', () => {
  const dir = tmpProfile()
  try {
    const written = quarantineEntries(dir, [{ message: 'no id' }, { id: '', message: 'empty' }])
    assert.deepEqual(written, [])
    // 不写文件（无有效条目）
    const file = join(dir, PROFILE_PATCH_FILENAME)
    try {
      readFileSync(file, 'utf8')
      assert.fail('should not create patch file')
    } catch (e) {
      assert.ok(e.code === 'ENOENT')
    }
  } finally {
    cleanup(dir)
  }
})

// ── mergePatchBlock（空数组 [] 替换，防 YAML 崩溃）──

test('mergePatchBlock: 空数组 []（DSH 默认）被 block 替换而非追加', () => {
  const body = '# wechat-bridge（运行时注入，见 dev_inject_plugin）\n\n[]\n'
  const block = `# quarantined by ${QUARANTINE_MARKER} at 2026-01-01T00:00:00.000Z — bad: boom\n- id: bad\n  disabled: true\n`
  const merged = mergePatchBlock(body, block)
  // 顶部注释保留、[] 消失、列表项出现
  assert.ok(merged.startsWith('# wechat-bridge'))
  assert.ok(!merged.includes('[]'))
  assert.ok(merged.includes('- id: bad'))
  assert.ok(merged.includes('disabled: true'))
  // 绝不残留 `[]` + `- id:` 两个文档混排的非法形态
  assert.ok(!/\[\s*\]/.test(merged))
})

test('mergePatchBlock: 已是列表（- id:）则直接追加', () => {
  const body = '- id: good\n  disabled: false\n'
  const merged = mergePatchBlock(body, '- id: bad\n  disabled: true\n')
  assert.ok(merged.includes('- id: good'))
  assert.ok(merged.includes('- id: bad'))
})

test('mergePatchBlock: 空文件直接写入 block', () => {
  assert.equal(mergePatchBlock('', '- id: bad\n'), '- id: bad\n')
})

test('mergePatchBlock: 无尾换行时自动补一个', () => {
  const merged = mergePatchBlock('- id: good', '- id: bad\n  disabled: true\n')
  assert.ok(merged.includes('- id: good\n- id: bad'))
})

test('quarantineEntries: profile patch 为 []（空数组）时合并后仍为合法列表', () => {
  const dir = tmpProfile()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '# wechat-bridge（运行时注入，见 dev_inject_plugin）\n\n[]\n', 'utf8')
    const written = quarantineEntries(dir, [{ id: 'bad', message: 'pkg: boom' }])
    assert.deepEqual(written, ['bad'])
    const body = readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')
    assert.ok(!body.includes('[]')) // 空数组被替换
    assert.match(body, /- id: bad\n\s+disabled: true/)
    // 关键：不再有 `[]` + `- id:` 混排（正是 2026-08-19 崩溃的 YAML 形态）
    assert.ok(!/\[\s*\]\s*\n\s*-\s*id:/.test(body))
  } finally {
    cleanup(dir)
  }
})

// ── filterQuarantinedPatches ──

test('filterQuarantinedPatches: 按 entry id 剔除整块 patch，其余保留', () => {
  const patches = [
    { insert: [{ id: 'good-a', name: 'pkg-a' }] },
    { insert: [{ id: 'bad', name: 'pkg-b' }, { id: 'good-b', name: 'pkg-c' }] },
    { insert: [{ id: 'good-c' }] },
  ]
  const filtered = filterQuarantinedPatches(patches, ['bad'])
  assert.equal(filtered.length, 2)
  assert.equal(filtered[0].insert[0].id, 'good-a')
  assert.equal(filtered[1].insert[0].id, 'good-c')
})

test('filterQuarantinedPatches: 无 insert 数组的 patch 保留（兼容 bundle 聚合形态）', () => {
  const patches = [{ name: 'no-insert' }, { insert: [{ id: 'bad' }] }]
  const filtered = filterQuarantinedPatches(patches, ['bad'])
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].name, 'no-insert')
})
