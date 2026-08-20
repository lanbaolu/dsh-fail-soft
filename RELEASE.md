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

## 配置层防御（0.1.6 起）

- **写前自动备份**：fail-soft 每次写 `cordis.patch.yml`（隔离/恢复）前把原文件备份为
  `cordis.patch.yml.bak.<ISO>`（保留最近 10 份）——`lib/mount-core.js backupPatchFile`。
- **解析失败自动恢复**：内核补丁 `loadProfile`（`loadUserPatchLayerFailSoft`）在
  **fail-soft 模式**下，用户层 patch YAML 解析失败时：明确诊断（文件/错误/恢复建议）
  → 从最近**合法**备份自动恢复（只认 `.bak.<ISO>` 格式、按时间取最新，排除旧命名/
  带后缀的手动备份）→ 启动继续；非 fail-soft 也提示如何恢复。
- 真实验证（2026-08-19）：手动写坏 patch（`[]` + `- id:` 混排）→ 重启 → 日志诊断 +
  自动恢复 + 服务照常起（fail-soft/usage-stats 正常）。

## 静默退出（方案①，0.1.7 起）

> 前提：DSH 版本变更（如 rc.8）仍可能让内核补丁/插件出错。方案① 保证：
> **fail-soft 补丁自身出错也绝不炸 DSH**——它只兜底插件错误，不能成为新的崩溃源。

内核补丁 4 个 fail-soft 介入点均有顶层 try-catch：
1. `loadUserPatchLayerFailSoft`：catch 内再保护，恢复逻辑出错不掩盖原始解析错误；
2. `mountRootIncludeFailSoft`：外层保护，补丁逻辑抛错降级为官方 `mountRootInclude`
   （最坏回到官方 fail-loud，不是 fail-soft 引入的新崩溃）；
3. `installFailLoud` fail-soft 分支：隔离逻辑出错仅打印，服务继续、绝不 exit；
4. `assertEntriesActivated` fail-soft 分支：隔离逻辑出错仅打印，不阻断启动。

## 自适应（方案③，0.1.9 起）——让补丁自动跟上 DSH 版本

> 目标：官方升级导致模板不匹配（needs-adaptation）时，不再等手工更新 backup/ 模板。

- **阶段一（0.1.9）**：官方**纯新增行**（如 rc.8 加 `"BROWSER"`）自动合并进 `patched`。
- **阶段二（0.1.10）**：升级为**三路合并（diff3）**——官方任意改动（新增/删除/修改，
  只要不与补丁改动冲突）都自动合并：
  - 官方删了补丁没动的行 → 跟随官方删除；
  - 补丁删了官方没动的行 → 跟随补丁删除；
  - 双方删同一行 / 同一锚点插不同内容 → 冲突，报需人工；
  - 相同内容块去重（幂等）。
  - 合并后 `node --check` 校验，失败回滚，绝不产出坏补丁。
- **命令**：`patch-apply.mjs --adapt`（只诊断不写回）；`--repair` 在
  needs-adaptation 时**自动尝试适配**（成功=repaired/adapt，失败=自动回滚+指引）。
- 端到端验证（2026-08-19）：模拟官方 rc.9 新增 `NEW_ENV` → `--adapt`
  `adaptive.ok=true`，**82 个补丁变更块全部保留**并合并官方新增。

## 修复引擎（方案②，0.1.8 起）——集成 dsh-fix 能力

> 目标：补丁失效/配置损坏时有**备用方案**，不再让用户面对"起不来"裸奔。

- **`patch-apply.mjs --repair` / `fail_soft_repair` 工具 / `POST /api/fail-soft/repair`**：
  - 内核补丁 `ok` → 无需处理；
  - `needs-apply`（npx 重装丢补丁）→ 自动重打；
  - `needs-adaptation`（官方改结构）→ **自动回滚到官方原版**（挂载兜底不生效、
    管理面/UI 仍可用）并给适配指引；
  - 同时**去重 profile patch 重复 entry id**（集成 dev_fix_patch / dsh-fix 能力，
    duplicate id 会致启动崩溃）。
- **`patch-apply.mjs --rollback`**：手动回滚到官方原版（`backup/*.orig`）。
- 完整闭环已验证（2026-08-19）：`--repair`(ok) → `--rollback`(pristine) →
  `--repair`(重打恢复 ok)。

## 内核补丁维护（上游化前的过渡策略）

> 外部评审指出侵入式内核补丁是最大技术债。治本 = 上游化（T4，向
> `deepseek-ai/deepseek-harness` 提 PR，见 STATUS「Next phase」）。过渡期用以下
> **补丁维护/回滚机制**持续保障，DSH 升级后按此体检：

1. **状态体检**：`cd 防止插件错误挂不起服务 && node patch-apply.mjs --check`
   - `ok` = 已打且匹配模板；
   - `needs-apply` = 补丁丢失（npx 重装）→ 重打：`node patch-apply.mjs`；
   - `needs-adaptation` = 官方改了结构 → **更新 `backup/` 模板**（抓官方新版→重打→存模板）
     再重打，绝不盲覆盖。
2. **回滚**：手动 `cp backup/dsh-app-boot.index.js.orig <DSH>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
   （profile-boot 同理）——回到官方原版，插件的运行期服务/UI 仍可用（仅挂载兜底不生效）。
3. **cordis.patch.yml 去重自愈**：`dev_fix_patch`（修复 duplicate loader entry id）。
4. **配置层兜底**：上面的写前备份 + 解析失败自动恢复，让手滑/补丁冲突不拖垮启动。

## 回归测试（维护验证）

```bash
npm test                       # 38 个单测（含 profileDirOf/开关/mergePatchBlock/[]/写前备份 场景）
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
