/**
 * patch-ops.test.js — profile patch 文件操作（隔离/解析/恢复）回归。
 * 覆盖：解析隔离标记、只删带隔离标记的条目、不截断其他条目、手动隔离幂等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUARANTINE_MARKER, readPatchEntries, removePatchEntry, quarantinePlugin, fixDuplicatePatchIds } from '../lib/patch-ops.js'

function tmpProfile(initial = '') {
  const dir = mkdtempSync(join(tmpdir(), 'fail-soft-patchops-'))
  if (initial) writeFileSync(join(dir, 'cordis.patch.yml'), initial, 'utf8')
  return dir
}

const SAMPLE = [
  '# top comment',
  '- id: good-plugin',
  '  config:',
  '    some: value',
  '',
  `# quarantined by ${QUARANTINE_MARKER} at 2026-01-01T00:00:00.000Z — bad-a: pkg-a: boom`,
  '- id: bad-a',
  '  disabled: true',
  '',
  `# quarantined by ${QUARANTINE_MARKER} at 2026-01-01T00:00:00.000Z — bad-b: pkg-b: boom`,
  '- id: bad-b',
  '  disabled: true',
  '',
  '- id: disabled-manual',
  '  disabled: true',
  '',
].join('\n')

test('readPatchEntries: 解析隔离标记 / disabled / 行号', () => {
  const dir = tmpProfile(SAMPLE)
  try {
    const { entries } = readPatchEntries(dir)
    assert.equal(entries.length, 4)
    const badA = entries.find((e) => e.id === 'bad-a')
    assert.ok(badA.quarantined)
    assert.ok(badA.disabled)
    assert.match(badA.reason, /pkg-a: boom/)
    const good = entries.find((e) => e.id === 'good-plugin')
    assert.ok(!good.quarantined)
    assert.ok(!good.disabled)
    const manual = entries.find((e) => e.id === 'disabled-manual')
    assert.ok(!manual.quarantined) // 无隔离标记的 disabled 不算隔离
    assert.ok(manual.disabled)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removePatchEntry: 只删带隔离标记的条目并连同注释，其余保留', () => {
  const dir = tmpProfile(SAMPLE)
  try {
    const res = removePatchEntry(dir, 'bad-a')
    assert.ok(res.ok)
    const body = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(!body.includes('bad-a'))
    assert.ok(!body.includes('pkg-a: boom')) // bad-a 的隔离注释随块删除
    assert.ok(body.includes('- id: good-plugin'))
    assert.ok(body.includes('- id: bad-b')) // 其他隔离条目保留（其注释也保留）
    assert.ok(body.includes('- id: disabled-manual')) // 普通 disabled 保留
    // 不截断：good-plugin 的 config 子行保留
    assert.ok(body.includes('some: value'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removePatchEntry: 拒绝删除无隔离标记的条目', () => {
  const dir = tmpProfile(SAMPLE)
  try {
    const res = removePatchEntry(dir, 'disabled-manual')
    assert.ok(!res.ok)
    assert.match(res.error, /不是 @lanbaolu\/dsh-fail-soft 隔离/)
    assert.ok(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').includes('disabled-manual'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removePatchEntry: 未找到 entry 返回错误', () => {
  const dir = tmpProfile(SAMPLE)
  try {
    const res = removePatchEntry(dir, 'nope')
    assert.ok(!res.ok)
    assert.match(res.error, /未找到/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quarantinePlugin: 写入 disabled + 隔离标记；已存在则拒绝', () => {
  const dir = tmpProfile('- id: existing\n  disabled: false\n')
  try {
    const res = quarantinePlugin(dir, 'manual-bad', 'pkg-m', 'test reason')
    assert.ok(res.ok)
    const body = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.match(body, /# quarantined by @lanbaolu\/dsh-fail-soft at [^ ]+ — manual-bad: pkg-m — test reason/)
    assert.match(body, /- id: manual-bad\n\s+disabled: true/)
    // 已存在 → 拒绝
    const dup = quarantinePlugin(dir, 'existing', 'x', 'y')
    assert.ok(!dup.ok)
    assert.match(dup.error, /已存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quarantinePlugin: patch 为 []（DSH 默认空数组）时替换而非追加，保持合法 YAML', () => {
  // 2026-08-19 真实事故形态：`[]` + `- id:` 两个文档混排 → 解析崩溃。
  const dir = tmpProfile('# wechat-bridge（运行时注入，见 dev_inject_plugin）\n\n[]\n')
  try {
    const res = quarantinePlugin(dir, 'manual-bad', 'pkg-m', 'test')
    assert.ok(res.ok)
    const body = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(!body.includes('[]')) // 空数组被替换
    assert.match(body, /- id: manual-bad\n\s+disabled: true/)
    assert.ok(!/\[\s*\]\s*\n\s*-\s*id:/.test(body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quarantinePlugin: 写前自动备份（.bak.* 含写前内容）', () => {
  const dir = tmpProfile('- id: existing\n  disabled: false\n')
  try {
    const res = quarantinePlugin(dir, 'manual-bad', 'pkg-m', 'test')
    assert.ok(res.ok)
    const baks = readdirSync(dir).filter((f) => f.startsWith('cordis.patch.yml.bak.'))
    assert.equal(baks.length, 1)
    const bak = readFileSync(join(dir, baks[0]), 'utf8')
    assert.ok(bak.includes('- id: existing'))
    assert.ok(!bak.includes('manual-bad'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removePatchEntry: 写前自动备份（.bak.* 含删除前内容）', () => {
  const dir = tmpProfile(`# quarantined by ${QUARANTINE_MARKER} at 2026-01-01T00:00:00.000Z — bad: pkg: boom\n- id: bad\n  disabled: true\n`)
  try {
    const res = removePatchEntry(dir, 'bad')
    assert.ok(res.ok)
    const baks = readdirSync(dir).filter((f) => f.startsWith('cordis.patch.yml.bak.'))
    assert.equal(baks.length, 1)
    const bak = readFileSync(join(dir, baks[0]), 'utf8')
    assert.ok(bak.includes('- id: bad')) // 备份保留了删除前的内容
    assert.ok(!readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').includes('- id: bad'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fixDuplicatePatchIds: 重复 entry id 只保留最后一条并写前备份', () => {
  const dir = tmpProfile('- id: good\n  disabled: false\n- id: good\n  disabled: true\n- id: other\n  disabled: false\n')
  try {
    const res = fixDuplicatePatchIds(dir)
    assert.ok(res.ok)
    assert.equal(res.removed, 1)
    const body = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.equal((body.match(/- id: good/g) || []).length, 1)
    assert.ok(body.includes('- id: other'))
    const baks = readdirSync(dir).filter((f) => f.startsWith('cordis.patch.yml.bak.'))
    assert.equal(baks.length, 1)
    assert.ok(readFileSync(join(dir, baks[0]), 'utf8').includes('- id: good\n  disabled: false'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
