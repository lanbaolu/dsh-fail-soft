/**
 * @lanbaolu/dsh-fail-soft — cordis 上下文工具（零 DSH 依赖，可独立测试）。
 *
 * 与 mount-core / patch-ops 一样保持"零 DSH 依赖"：profileDirOf 与持久化
 * 开关在无 DSH 生态的 CI（GitHub Actions verify job，未装 peerDeps）里也能
 * 直接单测。不要把这三个函数放回 lib/index.js —— index.js 顶层
 * `import '@deepseek-ai/dsh-tools'`，被它引用的模块会让 `npm test` 在 CI 上
 * ERR_MODULE_NOT_FOUND（本插件 0.1.2 发布前的实测坑）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 持久化开关文件（~/.dsh/fail-soft.json，与内核 isFailSoft 读取的完全一致）。 */
export const FAIL_SOFT_SWITCH_FILE = join(homedir(), '.dsh', 'fail-soft.json')

/**
 * 从 cordis ctx 推导 profile 目录。
 *
 * ⚠️ ctx.baseUrl 是 profile 目录的 URL，**以 '/' 结尾**（目录 URL）。因此
 * `fileURLToPath` 后得到带尾斜杠的目录路径，**去尾斜杠**即 profile 目录；
 * 绝不能 `dirname(fileURLToPath(ctx.baseUrl))` —— 尾斜杠会被当成文件名
 * 的一部分，dirname 误切到上级目录，隔离 patch 就写错了地方。
 *
 * 解析失败（缺 baseUrl / 非法 URL）返回 undefined，调用方按"无法定位
 * profile"降级处理，绝不 throw —— 本插件自己不能再成为挂载期的坏插件。
 */
export function profileDirOf(ctx) {
  try {
    const baseUrl = ctx?.baseUrl
    if (!baseUrl) return undefined
    return fileURLToPath(baseUrl).replace(/[\\/]+$/, '')
  } catch {
    return undefined
  }
}

/** 读取持久化开关：文件声明 `{ "enabled": true }` 时返回 true。 */
export function readFailSoftSwitch() {
  try {
    const data = JSON.parse(readFileSync(FAIL_SOFT_SWITCH_FILE, 'utf8'))
    return data?.enabled === true
  } catch {
    return false
  }
}

/** 写入持久化开关（fail_soft_set_enabled 工具/API 调用）。 */
export function writeFailSoftSwitch(enabled) {
  try {
    writeFileSync(FAIL_SOFT_SWITCH_FILE, JSON.stringify({ enabled: !!enabled }, null, 2) + '\n')
    return { ok: true, file: FAIL_SOFT_SWITCH_FILE, enabled: !!enabled }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
