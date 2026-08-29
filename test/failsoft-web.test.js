/**
 * failsoft-web.test.js — 第 2 层进程包装器回归。
 * 覆盖：decideRestart 五分支、崩溃输出解析分类（quarantinable/core）、
 * 崩溃→隔离写入集成（临时 profile 目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideRestart, parseCrashEntries } from '../scripts/failsoft-web.mjs'
import { quarantineEntries } from '../lib/mount-core.js'

// ── decideRestart 五分支 ──

test('decideRestart: 正常退出(0) → 不重拉', () => {
  assert.deepEqual(decideRestart({ code: 0, quarantinedWritten: 0, restarts: 0, maxRestarts: 3 }), {
    restart: false, reason: 'normal-exit',
  })
})

test('decideRestart: 崩溃 + 有隔离写入 → 重拉（quarantined）', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedWritten: 1, restarts: 0, maxRestarts: 3 }), {
    restart: true, reason: 'quarantined', quarantinedWritten: 1,
  })
})

test('decideRestart: 崩溃 + 隔离写入但达上限 → 停', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedWritten: 1, restarts: 3, maxRestarts: 3 }), {
    restart: false, reason: 'max-restarts',
  })
})

test('decideRestart: 崩溃 + 无隔离写入 + 首次 → 给一次机会（unknown-once）', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedWritten: 0, restarts: 0, maxRestarts: 3 }), {
    restart: true, reason: 'unknown-once',
  })
})

test('decideRestart: 崩溃 + 无隔离写入 + 已重拉过 → 停（not-plugin）', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedWritten: 0, restarts: 1, maxRestarts: 3 }), {
    restart: false, reason: 'not-plugin',
  })
})

// ── parseCrashEntries：崩溃输出解析与分类 ──

test('parseCrashEntries: 解析 loader entry 失败 → 第三方插件可隔离（排除 include 根）', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load:',
    'failed to apply loader entry include (cordis:include):',
    'failed to import loader entry broken-plugin (@e2e/broken-plugin):',
    "Cannot find package '@e2e/broken-plugin' imported from /Users/x/.dsh/profiles/web/",
    '    at async Include._apply',
  ].join('\n')
  const failures = parseCrashEntries(stderr)
  const ids = failures.map((f) => f.id)
  assert.deepEqual(ids, ['broken-plugin'], JSON.stringify(failures))
  assert.equal(failures[0].quarantinable, true)
  assert.equal(failures[0].name, '@e2e/broken-plugin')
})

test('parseCrashEntries: 官方核心 entry 失败 → core，不隔离', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load:',
    'failed to apply loader entry include (cordis:include):',
    'failed to apply loader entry dsh-host-webserver (@deepseek-ai/dsh-host-webserver):',
    'EADDRINUSE: address already in use :::3080',
  ].join('\n')
  const failures = parseCrashEntries(stderr)
  const f = failures.find((x) => x.id === 'dsh-host-webserver')
  assert.ok(f, JSON.stringify(failures))
  assert.equal(f.core, true)
  assert.equal(f.quarantinable, false)
})

test('parseCrashEntries: 空 stderr → 无 entry，不崩', () => {
  const failures = parseCrashEntries('')
  assert.deepEqual(failures, [])
})

// ── 崩溃→隔离写入集成（临时 profile）──

test('崩溃→隔离：quarantineEntries 写入 disabled patch（含 marker 注释 + 空数组替换）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'failsoft-web-'))
  try {
    // 模拟官方默认空 patch（[]）
    mkdirSync(dir, { recursive: true })
    const patchFile = join(dir, 'cordis.patch.yml')
    writeFileSync(patchFile, '[]\n', 'utf8')
    const written = quarantineEntries(dir, [{ id: 'broken-plugin', message: '@e2e/broken-plugin: BOOM' }])
    assert.deepEqual(written, ['broken-plugin'])
    const body = readFileSync(patchFile, 'utf8')
    assert.ok(body.includes('# quarantined by @lanbaolu/dsh-fail-soft'), body)
    assert.ok(body.includes('- id: broken-plugin'), body)
    assert.ok(body.includes('disabled: true'), body)
    assert.ok(!body.includes('[]'), '空数组应被替换而非混排')
    // 幂等：重复隔离同 id → 不再写入
    const again = quarantineEntries(dir, [{ id: 'broken-plugin', message: '@e2e/broken-plugin: BOOM again' }])
    assert.deepEqual(again, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
