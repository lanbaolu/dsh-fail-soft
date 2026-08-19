/**
 * profile-dir.test.js — profileDirOf(ctx) 回归。
 *
 * 修复背景（2026-08-19 真实事故）：本插件 apply 时调用 `profileDirOf(ctx)`，
 * 但该函数从未定义，抛 `profileDirOf is not defined` → 插件激活失败 →
 * fail-soft 把自己隔离 → 写坏 cordis.patch.yml → 服务起不来。
 *
 * 关键约定：cordis 插件的 `ctx.baseUrl` 是 **profile 目录的 URL，以 '/' 结尾**
 * （目录 URL）。取 profile 目录必须**去尾斜杠**，绝不能
 * `dirname(fileURLToPath(ctx.baseUrl))` —— 尾斜杠会被当成文件名切到上级目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileDirOf } from '../lib/index.js'

test('profileDirOf: 目录 URL（以 / 结尾）→ 去尾斜杠得 profile 目录', () => {
  const ctx = { baseUrl: 'file:///Users/odis/.dsh/profiles/web/' }
  assert.equal(profileDirOf(ctx), '/Users/odis/.dsh/profiles/web')
})

test('profileDirOf: 文件 URL（无尾斜杠）保持原样', () => {
  const ctx = { baseUrl: 'file:///Users/odis/.dsh/profiles/web' }
  assert.equal(profileDirOf(ctx), '/Users/odis/.dsh/profiles/web')
})

test('profileDirOf: 绝不误切上级（回归 dirname 坑）', () => {
  const ctx = { baseUrl: 'file:///Users/odis/.dsh/profiles/web/' }
  const result = profileDirOf(ctx)
  assert.notEqual(result, '/Users/odis/.dsh/profiles') // 上级目录是错的
  assert.equal(result, '/Users/odis/.dsh/profiles/web')
})

test('profileDirOf: 无 baseUrl → undefined（不抛）', () => {
  assert.equal(profileDirOf({}), undefined)
  assert.equal(profileDirOf(undefined), undefined)
  assert.equal(profileDirOf(null), undefined)
})

test('profileDirOf: 非法 URL → undefined（不抛）', () => {
  assert.equal(profileDirOf({ baseUrl: 'not a url' }), undefined)
})
