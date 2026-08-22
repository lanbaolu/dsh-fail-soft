/**
 * fail-soft-switch.test.js — 持久化开关（readFailSoftSwitch / writeFailSoftSwitch）回归。
 *
 * 修复背景（2026-08-19 第二轮崩溃）：恢复 fail-soft 加载后，插件在 apply 时
 * 抛 `readFailSoftSwitch is not defined` —— 这两个函数在 lib/index.js 中被
 * 调用但从未定义（此前一直被 disabled，从未实际执行过）。
 *
 * 测试用 `DSH_FAIL_SOFT_SWITCH_FILE` 环境变量把开关指向**临时目录**：不碰
 * 真实用户 ~/.dsh/fail-soft.json，也避免无 ~/.dsh 的 CI runner 上 ENOENT。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFailSoftSwitch, writeFailSoftSwitch, ensureFailSoftSwitchDefault } from '../lib/context-utils.js'

const ORIG_ENV = process.env.DSH_FAIL_SOFT_SWITCH_FILE

/** 每个用例开一个临时开关文件，跑完恢复 env + 清理。 */
function withTmpSwitch(run) {
  const dir = mkdtempSync(join(tmpdir(), 'fail-soft-switch-'))
  const file = join(dir, 'fail-soft.json')
  process.env.DSH_FAIL_SOFT_SWITCH_FILE = file
  try {
    return run(file)
  } finally {
    if (ORIG_ENV === undefined) delete process.env.DSH_FAIL_SOFT_SWITCH_FILE
    else process.env.DSH_FAIL_SOFT_SWITCH_FILE = ORIG_ENV
    rmSync(dir, { recursive: true, force: true })
  }
}

test('readFailSoftSwitch: 无文件/坏 JSON/未启用 → false，绝不抛', () =>
  withTmpSwitch((file) => {
    // 无文件
    assert.equal(readFailSoftSwitch(), false)
    // 坏 JSON
    writeFileSync(file, 'not json{')
    assert.equal(readFailSoftSwitch(), false)
    // 显式 false
    writeFileSync(file, '{ "enabled": false }')
    assert.equal(readFailSoftSwitch(), false)
    // true
    writeFileSync(file, '{ "enabled": true }')
    assert.equal(readFailSoftSwitch(), true)
  }))

test('writeFailSoftSwitch + readFailSoftSwitch: 写 true 读回 true，写 false 读回 false', () =>
  withTmpSwitch(() => {
    const w1 = writeFailSoftSwitch(true)
    assert.ok(w1.ok)
    assert.equal(w1.file, process.env.DSH_FAIL_SOFT_SWITCH_FILE)
    assert.equal(readFailSoftSwitch(), true)
    const w2 = writeFailSoftSwitch(false)
    assert.ok(w2.ok)
    assert.equal(readFailSoftSwitch(), false)
    // 写入格式与内核 isFailSoft 的 readFailSoftSwitch 兼容：{ enabled: boolean }
    const parsed = JSON.parse(readFileSync(process.env.DSH_FAIL_SOFT_SWITCH_FILE, 'utf8'))
    assert.deepEqual(parsed, { enabled: false })
  }))

// ── ensureFailSoftSwitchDefault（0.1.14 首装默认启用）──

test('ensureFailSoftSwitchDefault: 开关文件不存在 → 默认写入 enabled:true', () =>
  withTmpSwitch((file) => {
    const r = ensureFailSoftSwitchDefault()
    assert.equal(r.action, 'enabled-by-default')
    assert.equal(r.file, file)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: true })
    assert.equal(readFailSoftSwitch(), true)
    // 再次调用：已存在 → 保持
    assert.equal(ensureFailSoftSwitchDefault().action, 'already-enabled')
  }))

test('ensureFailSoftSwitchDefault: 用户显式禁用（enabled:false）→ 尊重，绝不覆盖', () =>
  withTmpSwitch((file) => {
    writeFileSync(file, JSON.stringify({ enabled: false }, null, 2) + '\n')
    const r = ensureFailSoftSwitchDefault()
    assert.equal(r.action, 'respected-disabled')
    assert.equal(readFailSoftSwitch(), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: false })
  }))

test('ensureFailSoftSwitchDefault: 已启用 → already-enabled；坏 JSON → 按未设置处理（默认开）', () =>
  withTmpSwitch((file) => {
    writeFileSync(file, JSON.stringify({ enabled: true }, null, 2) + '\n')
    assert.equal(ensureFailSoftSwitchDefault().action, 'already-enabled')
    writeFileSync(file, 'not json{')
    assert.equal(ensureFailSoftSwitchDefault().action, 'enabled-by-default')
    assert.equal(readFailSoftSwitch(), true)
  }))

test('ensureFailSoftSwitchDefault: 开关所在目录不存在 → 自动建目录再写入', () =>
  withTmpSwitch((file) => {
    const nested = join(dirname(file), 'no-such-subdir', 'fail-soft.json')
    process.env.DSH_FAIL_SOFT_SWITCH_FILE = nested
    const r = ensureFailSoftSwitchDefault()
    assert.equal(r.action, 'enabled-by-default')
    assert.deepEqual(JSON.parse(readFileSync(nested, 'utf8')), { enabled: true })
  }))
