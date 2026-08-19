/**
 * heal.test.js — 内核补丁自愈（检测/重打）回归。
 * 用临时目录模拟 DSH 安装结构，backup/ 真实模板作为 orig/patched 锚点。
 * 覆盖：checkPatch 四态（applied/pristine/changed/missing）、applyPatch（重打/跳过/官方改动拒绝）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPatch, applyPatch, getPatchStatus } from '../lib/heal.js'

const BACKUP = join(dirname(fileURLToPath(import.meta.url)), '..', 'backup')
const ORIG_APP = join(BACKUP, 'dsh-app-boot.index.js.orig')
const PATCHED_APP = join(BACKUP, 'dsh-app-boot.index.js.patched')
const ORIG_PB = join(BACKUP, 'dsh-profile-boot.js.orig')
const PATCHED_PB = join(BACKUP, 'dsh-profile-boot.js.patched')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 构造一个 fake DSH 安装目录（appBoot 与 profileBoot 内容由调用方指定文件）。 */
function fakeInstall(appBootSource, pbSource) {
  const dir = mkdtempSync(join(tmpdir(), 'fail-soft-heal-'))
  const appBoot = join(dir, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  mkdirSync(dirname(appBoot), { recursive: true })
  if (appBootSource) copyFileSync(appBootSource, appBoot)
  const pb = join(dir, '@deepseek-ai', 'dsh', 'lib', 'profile-boot-test.js')
  mkdirSync(dirname(pb), { recursive: true })
  if (pbSource) copyFileSync(pbSource, pb)
  writeFileSync(join(dir, '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify({ version: '0.1.0-rc.6' }), 'utf8')
  return { dir, appBoot, pb }
}

// ── checkPatch ──

test('checkPatch: applied（orig+patched 均已打）→ overall ok', async () => {
  const { dir } = fakeInstall(PATCHED_APP, PATCHED_PB)
  try {
    const r = await checkPatch(dir)
    assert.equal(r.appBoot.status, 'applied')
    assert.equal(r.profileBoot.status, 'applied')
    assert.equal(r.overall, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPatch: pristine（官方原版未打）→ overall needs-apply', async () => {
  const { dir } = fakeInstall(ORIG_APP, ORIG_PB)
  try {
    const r = await checkPatch(dir)
    assert.equal(r.appBoot.status, 'pristine')
    assert.equal(r.overall, 'needs-apply')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPatch: changed（官方已改动）→ overall needs-adaptation', async () => {
  const { dir, appBoot } = fakeInstall(null, ORIG_PB)
  try {
    writeFileSync(appBoot, '// official changed this file\n', 'utf8')
    const r = await checkPatch(dir)
    assert.equal(r.appBoot.status, 'changed')
    assert.equal(r.overall, 'needs-adaptation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPatch: missing（无 app-boot）→ overall needs-apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fail-soft-heal-missing-'))
  try {
    const r = await checkPatch(dir)
    assert.equal(r.overall, 'needs-apply')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── applyPatch ──

test('applyPatch: 官方原版 → 重打为 patched（appBoot 与 profileBoot 都变）', async () => {
  const { dir, appBoot, pb } = fakeInstall(ORIG_APP, ORIG_PB)
  try {
    const r = await applyPatch(dir)
    assert.deepEqual(r.applied.sort(), ['dsh-app-boot', 'profile-boot (profile-boot-test.js)'].sort())
    assert.equal(sha256(appBoot), sha256(PATCHED_APP))
    assert.equal(sha256(pb), sha256(PATCHED_PB))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyPatch: 已打 → skipped，无改动', async () => {
  const { dir, appBoot, pb } = fakeInstall(PATCHED_APP, PATCHED_PB)
  try {
    const r = await applyPatch(dir)
    assert.equal(r.applied.length, 0)
    assert.equal(sha256(appBoot), sha256(PATCHED_APP))
    assert.equal(sha256(pb), sha256(PATCHED_PB))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyPatch: 官方改动结构 → 抛错（不破坏文件）', async () => {
  const { dir, appBoot } = fakeInstall(null, PATCHED_PB)
  try {
    writeFileSync(appBoot, '// totally different content\n', 'utf8')
    await assert.rejects(() => applyPatch(dir), /不一致|已中止|找不到/)
    // 不破坏：文件内容保持原样
    assert.equal(readFileSync(appBoot, 'utf8'), '// totally different content\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── getPatchStatus ──

test('getPatchStatus: 显式目录返回 ok + 结构字段', async () => {
  const { dir } = fakeInstall(PATCHED_APP, PATCHED_PB)
  try {
    const r = await getPatchStatus(dir)
    assert.equal(r.status, 'ok')
    assert.equal(r.dir, dir)
    assert.ok(r.at)
    assert.ok(r.appBoot)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getPatchStatus: 不存在目录 → no-install 不抛错', async () => {
  const r = await getPatchStatus('/nonexistent/dsh-install/xyz/node_modules')
  assert.equal(r.status, 'no-install')
})
