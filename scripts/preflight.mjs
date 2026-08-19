#!/usr/bin/env node
/**
 * scripts/preflight.mjs — 发布前一致性预检（发布门禁）。
 *
 * 用法：
 *   node scripts/preflight.mjs                  # 检查 package.json 版本/README/tgz/git/测试
 *   node scripts/preflight.mjs --tag=v0.1.3     # 额外检查将打的 tag 版本与 package.json 一致
 *   node scripts/preflight.mjs --skip-tests     # 跳过 npm test（CI 场景）
 *
 * 背景（2026-08-19 教训）：发布 v0.1.3 时 README 顶部仍是 v0.1.2，版本不自洽就
 * 打 tag 发布，被用户发现。此后**任何发布动作前必须跑本脚本**，一致性不过禁止发布。
 *
 * 检查项：
 * 1. package.json version vs README 顶部「当前状态」版本号一致
 * 2. 发布产物 tgz（<包名>-<version>.tgz）存在
 * 3. git 工作区干净（无未提交改动）
 * 4. （--tag=vX.Y.Z）tag 版本 == package.json version；tag 已存在则报错提示
 * 5. 测试通过（node --test，零 devDeps 依赖，CI 兼容）
 */
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const issues = []

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const pkgBase = pkg.name.split('/').pop()

// ── 1. README 顶部版本一致 ──
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const headMatch = readme.match(/当前状态：\S*（v([0-9.]+)）/)
if (!headMatch) {
  issues.push('README 顶部未找到「当前状态（vX.Y.Z）」标记')
} else if (headMatch[1] !== version) {
  issues.push(`README 顶部「当前状态」版本 v${headMatch[1]} ≠ package.json ${version}——发布前必须同步 README`)
}

// ── 2. 发布产物 tgz ──
const tgzName = `${pkgBase}-${version}.tgz`
if (!existsSync(join(ROOT, tgzName))) {
  issues.push(`缺少发布产物 ${tgzName}——先 dev_build_plugin 构建打包`)
}

// ── 3. git 工作区干净 ──
const gitStatus = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim()
if (gitStatus) {
  issues.push(`git 工作区有未提交改动，发布前应全部提交:\n${gitStatus.split('\n').map((l) => '    ' + l).join('\n')}`)
}

// ── 4. tag 一致性（--tag=）──
const tagArg = process.argv.find((a) => a.startsWith('--tag='))
if (tagArg) {
  const tagV = tagArg.slice('--tag='.length).replace(/^v/, '')
  if (tagV !== version) issues.push(`将打的 tag ${tagArg} 版本 v${tagV} ≠ package.json ${version}`)
  const existing = execSync(`git tag -l "v${version}"`, { cwd: ROOT, encoding: 'utf8' }).trim()
  if (existing) issues.push(`tag v${version} 已存在——同版本不可重复发布（E403）。若是修复后重发，先删旧 tag 再打（git push origin :refs/tags/v${version} && git tag -d v${version}）`)
}

// ── 5. 测试 ──
if (!process.argv.includes('--skip-tests')) {
  try {
    execSync('node --test', { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' })
  } catch (e) {
    const tail = String(e.stdout || '').split('\n').slice(-12).join('\n')
    issues.push(`npm test 失败:\n${tail}`)
  }
}

if (issues.length > 0) {
  console.error(`❌ 发布前预检未通过（v${version}）：`)
  for (const i of issues) console.error(`  - ${i}`)
  process.exit(1)
}
console.log(`✅ 发布前预检通过（v${version}）：README 版本/tgz/git 工作区/测试 全部一致`)
