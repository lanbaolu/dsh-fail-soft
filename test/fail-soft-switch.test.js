/**
 * fail-soft-switch.test.js — 持久化开关（readFailSoftSwitch / writeFailSoftSwitch）回归。
 *
 * 修复背景（2026-08-19 第二轮崩溃）：恢复 fail-soft 加载后，插件在 apply 时
 * 抛 `readFailSoftSwitch is not defined` —— 这两个函数在 lib/index.js 中被
 * 调用但从未定义（此前一直被 disabled，从未实际执行过）。
 *
 * 注意：开关文件是真实用户文件 ~/.dsh/fail-soft.json，测试前后备份/恢复，
 * 绝不污染环境。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFailSoftSwitch, writeFailSoftSwitch } from '../lib/context-utils.js'

const SWITCH_FILE = join(homedir(), '.dsh', 'fail-soft.json')

function backup() {
  return existsSync(SWITCH_FILE) ? readFileSync(SWITCH_FILE, 'utf8') : null
}
function restore(prev) {
  if (prev === null) {
    try { rmSync(SWITCH_FILE, { force: true }) } catch { /* 忽略 */ }
    return
  }
  writeFileSync(SWITCH_FILE, prev)
}

test('readFailSoftSwitch: 无文件/坏 JSON/未启用 → false，绝不抛', () => {
  const prev = backup()
  try {
    writeFileSync(SWITCH_FILE, 'not json{')
    assert.equal(readFailSoftSwitch(), false)
    writeFileSync(SWITCH_FILE, '{ "enabled": false }')
    assert.equal(readFailSoftSwitch(), false)
    writeFileSync(SWITCH_FILE, '{ "enabled": true }')
    assert.equal(readFailSoftSwitch(), true)
  } finally {
    restore(prev)
  }
})

test('writeFailSoftSwitch + readFailSoftSwitch: 写 true 读回 true，写 false 读回 false', () => {
  const prev = backup()
  try {
    const w1 = writeFailSoftSwitch(true)
    assert.ok(w1.ok)
    assert.equal(readFailSoftSwitch(), true)
    const w2 = writeFailSoftSwitch(false)
    assert.ok(w2.ok)
    assert.equal(readFailSoftSwitch(), false)
    // 写入格式与内核 isFailSoft 的 readFailSoftSwitch 兼容：{ enabled: boolean }
    const parsed = JSON.parse(readFileSync(SWITCH_FILE, 'utf8'))
    assert.deepEqual(parsed, { enabled: false })
  } finally {
    restore(prev)
  }
})
