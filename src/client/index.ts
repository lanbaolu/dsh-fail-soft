/**
 * @lanbaolu/dsh-fail-soft — client 设置面板（settings.section slot）。
 *
 * 在 DSH 设置面板注册「Fail-soft 隔离」区域，使用官方
 * @deepseek-ai/dsh-client-ui-primitives（Button / Pill / StateDot）保持与
 * DSH 主题一致：
 * - 状态卡（fail-soft 是否生效 + 内核补丁健康）；
 * - 一键开关（写 ~/.dsh/fail-soft.json，重启后生效）；
 * - 被隔离插件提示。
 *
 * 构建：npm run build:client（tsdown → lib/client.js，ModuleLoader 包装）。
 */
// @ts-nocheck
import * as React from 'react'
import { Button, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const cardStyle = {
  background: 'var(--dsw-alias-surface-2, #fafafa)',
  border: '1px solid var(--dsw-alias-border-l2, #e6e6e6)',
  borderRadius: 10,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary, #555)',
}
const hintStyle = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary, #999)',
  lineHeight: 1.5,
}

/** 设置面板里的 fail-soft 区域。 */
function FailSoftSettingsSection() {
  const [status, setStatus] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState('')

  const refresh = async () => {
    try {
      const res = await fetch('/api/fail-soft/status')
      setStatus(await res.json())
    } catch {
      setStatus(null)
    }
  }
  React.useEffect(() => {
    void refresh()
  }, [])

  const toggle = async () => {
    const next = !(status?.switchEnabled === true)
    setSaving(true)
    setMessage('')
    try {
      const res = await fetch('/api/fail-soft/set-enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const result = await res.json()
      if (result?.ok) {
        setMessage(next ? '✅ 已开启，重启 dsh 后生效' : '✅ 已关闭，重启 dsh 后生效')
        await refresh()
      } else {
        setMessage('❌ ' + (result?.error || '设置失败'))
      }
    } catch {
      setMessage('❌ 请求失败')
    }
    setSaving(false)
  }

  const switchOn = status?.switchEnabled === true
  const enabled = status?.enabled === true
  const quarantined = status?.quarantined ?? []
  const patch = status?.patch ?? {}
  const patchOk = patch.status === 'ok' || patch.status === 'repaired'
  const patchText =
    patch.status === 'ok' ? '正常'
    : patch.status === 'checking' ? '检测中…'
    : patch.status === 'repaired' ? '已自动重打（重启后生效）'
    : patch.status === 'needs-adaptation' || patch.status === 'failed' || patch.status === 'no-install' ? '需适配'
    : String(patch.status ?? '?')

  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    // 标题行：名称 + 开关 pill
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      React.createElement('span', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } },
        '🔧 Fail-soft 隔离'),
      React.createElement(Pill, { active: switchOn }, switchOn ? '开关：开' : '开关：关'),
    ),

    // 状态卡
    React.createElement('div', { style: cardStyle },
      React.createElement('div', { style: rowStyle },
        React.createElement(StateDot, { state: enabled ? 'done' : 'error' }),
        React.createElement('span', null, enabled
          ? 'fail-soft 已启用（坏插件会被自动隔离，服务照常启动）'
          : 'fail-soft 未启用（坏插件可能导致整个服务起不来）'),
      ),
      React.createElement('div', { style: rowStyle },
        React.createElement(StateDot, { state: patchOk ? 'done' : 'warning' }),
        React.createElement('span', null, '内核补丁：' + patchText),
      ),
      quarantined.length > 0
        ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ff6b6b', fontWeight: 600 } },
            React.createElement(StateDot, { state: 'error' }),
            React.createElement('span', null,
              `已隔离 ${quarantined.length} 个插件：${quarantined.map((q) => q.id).join('、')}`),
          )
        : null,
    ),

    // 开关动作
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement(Button, {
        variant: switchOn ? 'outline' : 'primary',
        size: 'md',
        onClick: () => void toggle(),
        disabled: saving || !status,
      }, saving ? '处理中…' : (switchOn ? '关闭 fail-soft' : '开启 fail-soft')),
    ),

    // 提示与反馈
    React.createElement('div', { style: hintStyle },
      '开关写入 ~/.dsh/fail-soft.json，内核启动时读取；App / 终端都无需设置环境变量。切换后请重启 dsh 生效。'),
    message ? React.createElement('div', { style: { fontSize: 12, color: '#8f8fff' } }, message) : null,
  )
}

export function apply(ctx: ClientContext): void {
  // 必须走 inject 而不是裸 register：'settings.section' 这个 slot 由设置面板
  // 根 entry（client-ui-settings-general SettingsRoot 的 children 表）声明。
  // 裸 register 有装载顺序依赖——本插件 client entry 的 effect 先跑、声明还
  // 没就位时，register 直接 throw「slot is not declared」，弄崩整个插件
  // loader entry（0.1.15 修复：用户装完即报
  // "failed to apply loader entry ... slot 'settings.section' is not declared"）。
  // inject 的契约（dsh-cordis-client-runner 服务文档）：声明已存在 → 立即执行
  // callback；尚未声明 → 等声明提交后在声明方 register() 内执行；永不声明 →
  // 贡献保持 pending，插件其余部分不受影响。卸载时等待自动取消。
  const contribute = () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-fail-soft',
    label: () => 'Fail-soft 隔离',
    inject: () => ({}),
  }, () => React.createElement(FailSoftSettingsSection))

  const guarded = () => {
    try {
      return contribute()
    } catch (err) {
      // fail-soft 插件自己绝不能 fail-loud：注册失败只降级（没有设置面板），
      // 隔离/恢复/开关等核心能力照常。
      console.warn('[dsh-fail-soft] settings section 注册失败，已降级为无面板：', err)
      return () => {}
    }
  }

  if (typeof (ctx.slots as { inject?: unknown }).inject === 'function') {
    ctx.slots.inject('settings.section', guarded)
    return
  }
  // 极老版本（无 inject）兜底：裸 register + 容错，宁可没面板也不崩。
  ctx.effect(guarded, '@lanbaolu/dsh-fail-soft: settings section')
}
