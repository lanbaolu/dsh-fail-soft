#!/bin/bash
# dsh-fail-soft build.
#
# host 部分（lib/mount.js、lib/index.js）为手写纯 JS ESM，无需 tsc 编译。
# 关键一步：把运行时依赖 link 进本插件的 node_modules —— ESM 的 bare
# import（@deepseek-ai/dsh-app-boot、@deepseek-ai/dsh-tools）从模块文件所在
# 目录向上解析，link 插件没有自己的依赖树时解析不到 profile 的 node_modules。
# 依赖源优先 DSH_DEPS_ROOT，其次探测 npx 缓存，最后 profiles 共享目录。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 探测依赖源 ──
DEPS_ROOT="${DSH_DEPS_ROOT:-}"
if [ -z "$DEPS_ROOT" ] || [ ! -d "$DEPS_ROOT/@deepseek-ai" ]; then
  for cand in "$HOME/.npm/_npx"/*/node_modules; do
    if [ -d "$cand/@deepseek-ai/dsh-app-boot" ]; then DEPS_ROOT="$cand"; break; fi
  done
fi
if [ -z "$DEPS_ROOT" ] || [ ! -d "$DEPS_ROOT/@deepseek-ai" ]; then
  if [ -d "$HOME/.dsh/profiles/node_modules/@deepseek-ai" ]; then DEPS_ROOT="$HOME/.dsh/profiles/node_modules"; fi
fi
if [ -z "$DEPS_ROOT" ] || [ ! -d "$DEPS_ROOT/@deepseek-ai" ]; then
  echo "build: cannot locate a DSH dependency root (set DSH_DEPS_ROOT)" >&2
  exit 1
fi
echo "=== Linking runtime deps from: $DEPS_ROOT ==="

link_dep() {
  local name="$1"
  mkdir -p "node_modules/$(dirname "$name")"
  ln -sfn "$DEPS_ROOT/$name" "node_modules/$name"
  echo "  link $name"
}
link_dep "@deepseek-ai/dsh-app-boot"
link_dep "@deepseek-ai/dsh-tools"

# ── 校验 host 产物 ──
for f in lib/index.js lib/mount.js; do
  if [ ! -f "$f" ]; then echo "build: missing $f" >&2; exit 1; fi
done
node --check lib/index.js
node --check lib/mount.js
echo "=== Build complete (host JS verified; run build:client for the panel) ==="
