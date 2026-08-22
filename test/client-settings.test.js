/**
 * client-settings.test.js — client 设置面板注册的防崩回归。
 *
 * 背景（0.1.15）：'settings.section' slot 由设置面板根 entry（client-ui-
 * settings-general 的 children 表）声明。早期版本在 apply 里裸调
 * `ctx.slots.register(...)`，当本插件 client entry 的 effect 先于声明就位
 * 时，register 抛「slot "settings.section" is not declared」，弄崩整个插件
 * loader entry（用户真实反馈：装完即 "Failed to load plugins"）。
 *
 * 修复后行为契约（本测试覆盖）：
 * 1. 有 inject（现行 DSH）：apply 走 ctx.slots.inject，声明未就位时等待、
 *    不 throw；callback 内 register 抛错也被吞掉（降级无面板，返回空 disposer）。
 * 2. 有 inject 且 register 正常：callback 透传真实 disposer。
 * 3. 无 inject（极老版本）：走 ctx.effect 兜底，register 抛错不上抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 用假 ModuleLoader 装载 lib/client.js，拿到模块 exports。 */
function loadClient() {
  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  let captured
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        const fakeRequire = (name) => {
          if (name === 'react') return { createElement: () => ({ type: 'el' }) }
          return { Button: () => null, Pill: () => null, StateDot: () => null }
        }
        captured = spec.factory(fakeRequire)
      },
    },
  }
  // lib/client.js 顶层只引用 window.__ModuleLoader__，无其他浏览器依赖。
  new Function('window', src)(fakeWindow)
  if (!captured) throw new Error('ModuleLoader.load 未被调用（包装结构变了？）')
  return captured
}

test('apply：有 inject —— 声明未就位时等待（不 throw），callback 内 register 抛错被降级', () => {
  const exports = loadClient()
  const calls = []
  let callback
  const ctx = {
    slots: {
      inject(key, cb) {
        calls.push(['inject', key])
        callback = cb
        return () => calls.push(['inject-dispose'])
      },
      register() {
        calls.push(['register'])
        throw new Error('slot "settings.section" is not declared (a parent entry\'s children table must declare it)')
      },
    },
    effect() {
      throw new Error('有 inject 时不应走 effect 兜底')
    },
  }

  // apply 本身绝不能抛（这是 0.1.15 前崩溃的直接原因）。
  exports.apply(ctx)
  assert.deepEqual(calls[0], ['inject', 'settings.section'])

  // 模拟声明稍后才出现、runner 在声明方 register() 内执行 callback：
  // 此时我们的 register 抛错 → 必须吞掉并返回空 disposer，不能炸到声明方。
  const disposer = callback()
  assert.equal(typeof disposer, 'function')
  assert.ok(calls.some((c) => c[0] === 'register'))
  disposer() // 空 disposer 可安全调用
})

test('apply：有 inject 且 register 正常 —— 透传真实 disposer', () => {
  const exports = loadClient()
  let registered = false
  let callback
  const ctx = {
    slots: {
      inject(key, cb) {
        callback = cb
        return () => {}
      },
      register() {
        registered = true
        return 'real-disposer-sentinel'
      },
    },
    effect() {
      throw new Error('有 inject 时不应走 effect 兜底')
    },
  }
  exports.apply(ctx)
  assert.equal(callback(), 'real-disposer-sentinel')
  assert.ok(registered)
})

test('apply：极老版本无 inject —— effect 兜底，register 抛错不上抛', () => {
  const exports = loadClient()
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    let effectRan = false
    const ctx = {
      slots: {
        register() {
          throw new Error('slot "settings.section" is not declared')
        },
      },
      effect(fn, label) {
        effectRan = true
        assert.match(String(label), /settings section/)
        const disposer = fn()
        assert.equal(typeof disposer, 'function')
        return disposer
      },
    }
    exports.apply(ctx)
    assert.ok(effectRan)
    assert.ok(warnings.some((w) => w.includes('降级')))
  } finally {
    console.warn = origWarn
  }
})
