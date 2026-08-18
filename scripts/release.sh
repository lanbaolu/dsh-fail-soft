#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# @lanbaolu/dsh-fail-soft — 一键发布整套动作
# ═══════════════════════════════════════════════════════════════════════════
# 一条命令完成：bump 版本 → 构建校验 → 打包 → git 提交/推送 → 打 tag
# （触发 npm Trusted Publishing 自动上传）→ 建 GitHub Release → 验证 npm。
#
# 前置：npm 后台已配 Trusted Publishing（Provider GitHub / 仓库
# lanbaolu/dsh-fail-soft / workflow publish.yml）；gh 已登录。
#
# 用法：
#   ./scripts/release.sh 0.0.4         # 发布新版本（推荐，走 tp 自动上传）
#   ./scripts/release.sh 0.0.4 --no-git   # 只做 bump+构建+打包+release，不提交不推 tag
#   ./scripts/release.sh --check          # 检查发布前置（gh/npm/TP）
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log()  { printf '\033[36m[release]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[✗] %s\033[0m\n' "$*" >&2; exit 1; }

VERSION="${1:-}"
NO_GIT=0
[ "${2:-}" = "--no-git" ] && NO_GIT=1

if [ "$VERSION" = "--check" ] || [ -z "$VERSION" ]; then
  log "发布前置检查"
  command -v gh >/dev/null || die "缺少 gh CLI"
  command -v npm >/dev/null || die "缺少 npm"
  gh auth status >/dev/null 2>&1 || die "gh 未登录"
  [ -d node_modules/@deepseek-ai/dsh-app-boot ] || log "提示: 本地运行时依赖未 link（先跑 bash scripts/build.sh）"
  echo "  仓库: $(git remote get-url origin)"
  echo "  TP 前置: npm 后台需已配 Trusted Publishing（仓库 lanbaolu/dsh-fail-soft / workflow publish.yml）"
  log "一切就绪（若 npm 后台已配 TP）"
  exit 0
fi

# 版本号校验：x.y.z
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "版本号格式错误: $VERSION（应为 x.y.z 或 x.y.z-rc.n）"

# ── 1. bump 版本 ──
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync('package.json','utf8'));
d.version='$VERSION';
fs.writeFileSync('package.json', JSON.stringify(d,null,2)+'\n');
const l=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
l.version='$VERSION';
if(l.packages['']) l.packages[''].version='$VERSION';
fs.writeFileSync('package-lock.json', JSON.stringify(l,null,2)+'\n');
"
log "bump → $VERSION"

# ── 2. 构建校验（host 手写 JS + client）──
bash scripts/build.sh
npm run build:client >/dev/null 2>&1 && ok "client 构建" || die "client 构建失败"

# ── 3. 打包 ──
rm -f *.tgz
TARBALL="$(npm pack --silent 2>/dev/null | tail -1)"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "npm pack 失败"
ok "打包 $TARBALL"

# ── 4/5/6. git 提交 + 打 tag（触发 npm tp 自动上传）──
if [ "$NO_GIT" = "0" ]; then
  git add package.json package-lock.json lib/client.js lib/client.js.map 2>/dev/null || git add -A
  git -c user.name="dsh-fail-soft" -c user.email="dsh-fail-soft@local" commit -q -m "release: v$VERSION" || log "无新提交（沿用当前 HEAD）"
  git push origin main >/dev/null 2>&1 && ok "推送 main"
  git tag "v$VERSION" && git push origin "v$VERSION" >/dev/null 2>&1 && ok "tag v$VERSION 已推送（npm tp 自动上传已触发）"
fi

# ── 7. GitHub Release ──
NOTES="## @lanbaolu/dsh-fail-soft v$VERSION

插件错误自动隔离：坏插件被禁用、其余插件照常启动，服务不再被单个坏插件拖垮。

- 内核委托插槽 + 挂载兜底（lib/mount.js）
- 内核补丁自愈（lib/heal.js）：跟随 DSH 官方更新自动重打
- failSoft 服务 + fail_soft_* 工具 + /api/fail-soft/* API + UI 面板
- 安装：dsh plugin --profile web add @lanbaolu/dsh-fail-soft
- 启用：DSH_FAIL_SOFT=1"
gh release create "v$VERSION" "$TARBALL" --repo "$(git remote get-url origin | sed -E 's#https://github.com/([^/]+)/([^/.]+)(\.git)?#\1/\2#')" --title "dsh-fail-soft v$VERSION" --notes "$NOTES" >/dev/null 2>&1 && ok "GitHub Release v$VERSION" || log "GitHub Release 创建失败/已存在"

# ── 8. 等待 npm tp 自动上传并验证 ──
if [ "$NO_GIT" = "0" ]; then
  log "等待 npm 自动上传（tp / OIDC）…"
  for i in $(seq 1 20); do
    sleep 6
    LATEST="$(curl -s --max-time 8 "https://registry.npmjs.org/-/package/@lanbaolu%2fdsh-fail-soft/dist-tags" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).latest)}catch{console.log('')}})" 2>/dev/null || true)"
    if [ "$LATEST" = "$VERSION" ]; then ok "npm 已发布 $VERSION（dist-tags latest）"; exit 0; fi
  done
  die "npm 自动上传未在预期时间内完成（检查 GitHub Actions / npm 后台 TP 配置）"
fi

log "完成（--no-git 模式：仅 bump+构建+打包+Release）"
