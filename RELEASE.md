# RELEASE.md — 维护者发布流程（dsh-fail-soft）

> 面向维护者（lanbaolu）。用户不需要看这个文件；插件使用见 `README.md`。

## 发布前门禁（必须全部通过，否则禁止发布）

1. **读发布 SOP**：`memory_search "npm 发布正确流程"`（记忆 ID
   `330cd789-b0cb-45a6-8e13-6d49d6002a18`），不要凭记忆/猜测。
2. **跑一致性预检**：`npm run preflight -- --tag=vX.Y.Z`
   - 核对：`package.json version` == README 顶部「当前状态」== tgz 文件名 == 将打的 tag；
   - git 工作区干净；`node --test` 全过。
3. **内核补丁状态**：`cd 防止插件错误挂不起服务 && node patch-apply.mjs --check`
   应为 `ok`。
4. **文档自洽**：README/本文件里提到的版本号、功能状态必须与本次发布一致
   （不允许"发 0.1.4 文档写 0.1.3"，2026-08-19 教训）。

## 发布（Trusted Publishing 自动上传）

```bash
npm run build            # host 校验 + link 运行时依赖
npm run build:client     # tsdown → lib/client.js（UI 面板）
npm pack                 # 检查分发 tgz 内容
# 提交版本 bump + README 同步后：
npm run preflight -- --tag=vX.Y.Z    # 门禁，必须 ✅
git tag vX.Y.Z && git push origin vX.Y.Z   # → Actions 自动 npm publish --provenance
# 发布成功后建 GitHub Release（附件 tgz + 说明）：
gh release create vX.Y.Z lanbaolu-dsh-fail-soft-vX.Y.Z.tgz --notes "..."
```

- 首次发布（包在 npmjs 无页面、无法先配 TP）：npmjs Access Tokens 建 token →
  真实终端 `npm publish --registry=https://registry.npmjs.org --access public --provenance=false`
  （2FA 浏览器验证；npm 非 TTY 会把授权 URL 打成 `***`，必须在真实终端跑）。
- 同版本不可重复发布（E403）。修复后重发需先删旧 tag：
  `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`，再走上面流程。

## 发布后复查

```bash
npm view @lanbaolu/dsh-fail-soft version        # 应为新版本
gh release view vX.Y.Z --json assets            # 附件齐全（tgz）
npm view @lanbaolu/dsh-fail-soft readme | head   # npm 包 README 已同步（publish 时打包）
```

## 回归测试（维护验证）

```bash
npm test                       # 35 个单测（含 profileDirOf/开关/mergePatchBlock/[] 场景）
node scripts/preflight.mjs     # 一致性门禁
# 挂载兜底独立 profile 端到端（fixtures 坏插件）：
#   工作目录 防止插件错误挂不起服务/：node test-boot.mjs <profile>
#   真实 GUI 全链路：临时装配 fixtures/dsh-bad-plugin → 重启 → 应被隔离、服务照常起 → restore → 清理
```

## 已知发布坑（勿重复踩）

- npm pack 对 scoped 包 `@lanbaolu/dsh-fail-soft` 的 tgz 是
  `lanbaolu-dsh-fail-soft-<ver>.tgz`（去 @ 与 /），不是裸名 `dsh-fail-soft`。
- 新增测试**不要 import `lib/index.js`**（顶层依赖 `@deepseek-ai/dsh-tools` peerDep，
  CI verify 未装会 ERR_MODULE_NOT_FOUND）；纯函数放 `lib/context-utils.js` /
  `lib/mount-core.js` / `lib/patch-ops.js` 这类零 DSH 依赖模块再测。
- 测试开关等真实用户文件时用 `DSH_FAIL_SOFT_SWITCH_FILE` 临时目录，别碰 `~/.dsh`。
- README 面向用户，发布/构建/回归等维护流程只放本文件，不进 README 主体。
