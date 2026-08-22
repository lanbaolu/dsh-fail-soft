/**
 * @lanbaolu/dsh-plugin-hub — suite:doctor 健康自检（三态判定）。
 *
 * 状态机：
 *   PLATFORM_READY  全部就绪 → 市场可装插件
 *   NEEDS_RESTART   fail-soft 已装但补丁未生效 → 重启后 heal 自动重打
 *   NEEDS_FIX       组件缺失 / 补丁需适配 / 服务不可达 → 修复后重试
 *
 * 依赖注入（deps）便于独立测试；生产组装见 lib/index.js / scripts/doctor-cli.mjs。
 */
export const STATUS_READY = 'PLATFORM_READY'
export const STATUS_RESTART = 'NEEDS_RESTART'
export const STATUS_FIX = 'NEEDS_FIX'

/**
 * 运行 doctor 检查并给出三态。
 * @param {object} deps
 * @param {() => Promise<{status: string, error?: string, version?: string}>} deps.checkPatch
 *   fail-soft 内核补丁健康（status: ok | needs-apply | needs-adaptation | no-install | failed）
 * @param {() => {ok: boolean, detail?: string}} deps.checkInjectorRegistry
 *   super-injector registry 可达性
 * @param {() => {ok: boolean, detail?: string}} deps.checkHubService
 *   plugin-hub 自身服务
 * @returns {Promise<{status: string, checks: Array<{name:string, ok:boolean, detail:string}>, blockers: string[], ok: number, total: number, at: string}>}
 */
export async function runDoctor(deps) {
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail })

  // ── 1. fail-soft 内核补丁健康（第一原则的承载层）──
  let patch = null
  try {
    patch = await deps.checkPatch()
  } catch (e) {
    patch = { status: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
  const patchStatus = patch?.status
  if (patchStatus === 'ok') {
    add('fail-soft 内核补丁', true, `ok${patch?.version ? ` (DSH ${patch.version})` : ''}`)
  } else if (patchStatus === 'needs-apply') {
    add('fail-soft 内核补丁', false, 'needs-apply：补丁未生效——重启 dsh 后由 fail-soft 自动重打')
  } else if (patchStatus === 'needs-adaptation') {
    add('fail-soft 内核补丁', false, `needs-adaptation：DSH 内核结构已变，需更新 backup 模板${patch?.error ? ` — ${patch.error}` : ''}`)
  } else if (patchStatus === 'no-install') {
    add('fail-soft 内核补丁', false, `no-install：${patch?.error ?? '无法定位 DSH 安装'}`)
  } else {
    add('fail-soft 内核补丁', false, patch?.error ?? `unknown: ${patchStatus}`)
  }

  // ── 2. super-injector registry 可达 ──
  let inj
  try {
    inj = deps.checkInjectorRegistry()
  } catch (e) {
    inj = { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
  add('super-injector registry', inj?.ok === true, inj?.detail ?? '')

  // ── 3. plugin-hub 服务 ──
  let hub
  try {
    hub = deps.checkHubService()
  } catch (e) {
    hub = { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
  add('plugin-hub 服务', hub?.ok === true, hub?.detail ?? '')

  // ── 汇总 ──
  const failed = checks.filter((c) => !c.ok)
  const blockers = failed.map((c) => `${c.name}: ${c.detail}`)
  let status = STATUS_READY
  if (failed.length > 0) {
    const patchCheck = checks.find((c) => c.name === 'fail-soft 内核补丁')
    const patchDetail = patchCheck?.detail ?? ''
    if (patchDetail.includes('needs-apply')) status = STATUS_RESTART
    else status = STATUS_FIX
  }

  return {
    status,
    checks,
    blockers,
    ok: checks.length - failed.length,
    total: checks.length,
    at: new Date().toISOString(),
  }
}

export default runDoctor
