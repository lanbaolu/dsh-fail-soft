# @lanbaolu/dsh-fail-soft

> ✅ **当前状态：核心稳定候选（v0.1.0）**
>
> 已补齐自动化测试（隔离写入 / 解析 / 恢复 / 补丁自愈三分支，`npm test`），
> 并抽出 `getPatchStatus()` 供 doctor 等管理面调用。仍依赖 DSH 内核补丁，
> 升级 DSH 后请通过 `fail_soft_status` 的 `patch` 字段确认补丁健康状态，
> 若显示 `needs-adaptation` 请先更新 `backup/` 模板再继续使用。

**插件错误自动隔离**：坏插件被禁用、其余插件照常启动，提供隔离管理与恢复 UI。

## 解决的问题

DSH 的插件装配是 fail-loud：bundle 里**任何一个**插件加载/激活失败，整个
`dsh web` 服务就起不来（进程退出，GUI 打不开）。装一个坏插件 = 服务瘫痪，
且报错是一长串内部堆栈。

本插件让服务在坏插件面前**照常启动**：坏插件被自动隔离（写 disabled patch），
其余插件正常装配；隔离列表可查、可一键恢复（工具 + UI 面板）。

## 组成

| 部分 | 文件 | 作用 |
|---|---|---|
| 挂载兜底 | `lib/mount.js` | 被 DSH 内核（`DSH_FAIL_SOFT=1` 时）在 include 树挂载前动态加载：坏插件 → 隔离 → 剔除重试 |
| 运行期服务 | `lib/index.js` | `failSoft` 服务 + `fail_soft_*` 工具 + `/api/fail-soft/*` HTTP API |
| UI 面板 | `lib/client.js` | conversation.view 面板：隔离列表 + 一键恢复 |

## 前置条件（一次性）

内核需要"fail-soft 委托插槽"补丁（极小，只做发现与委托，逻辑全在本插件）。

- **npm 安装用户（0.0.9+）**：不需要手动打补丁。npm 包自带 `backup/` 补丁模板，
  插件每次启动时 `heal` 会自动检测；若内核是官方原版会自动打上补丁，
  **首次安装后请重启一次 dsh** 让挂载兜底生效。
- **本地开发**：也可用 `node patch-apply.mjs`（见工作目录 `防止插件错误挂不起服务/`，
  sha256 校验，DSH 更新后重打）。

不装内核补丁时：本插件的运行期服务/UI 仍可用（查隔离、手动隔离、恢复），
但挂载期自动隔离不生效（崩溃发生在任何插件加载之前，纯插件无法拦截）。

## 跟随 DSH 官方更新（内核补丁自愈）

DSH 官方升级 = npx 重新拉包到新的 `~/.npm/_npx/<hash>/` 目录，内核补丁
会被覆盖丢失。本插件每次启动时自动运行 **内核补丁自愈**（`lib/heal.js`）：

- **动态定位**实际运行的 DSH 安装（不硬编码 npx hash，可从当前进程 argv 推断）；
- **检测**补丁状态：`ok`（已打）/ `needs-apply`（丢失，npx 重装同版本）/ `needs-adaptation`（官方改了代码结构）；
- **自动重打**：仅当目标与"已知原始版"一致时安全重打（含 `profile-boot-*.js` 文件名 hash 变化的情况）；
- **官方改动结构**时报告 `needs-adaptation` 并提示更新 backup/ 模板，**绝不破坏新版代码**。

补丁健康状态可通过 `fail_soft_status` 工具、`/api/fail-soft/status`（`patch` 字段）、
UI 面板（🧩 行）查看。命令行重打：`node patch-apply.mjs`（与插件共用同一套 heal 逻辑）。

> 版本适配：当官方大幅重构挂载链路、自愈报告 `needs-adaptation` 时，需要更新
> `backup/` 里的 orig/patched 模板（抓官方新版 → 重打 → 存模板），通常一个版本一次。

## 安装（装入 profile）

> ⚠️ **命名必须与包名完全一致**：本插件的包名是 **`@lanbaolu/dsh-fail-soft`**（带 scope）。
> profile 的 dependencies key、`bundles` 条目、node_modules 链接、以及
> `cordis.patch.yml` 的 insert `name` **必须全部使用这个完整包名**。
> **不要**因为仓库/目录名是 `dsh-fail-soft` 或 tgz 文件名是
> `lanbaolu-dsh-fail-soft-*.tgz` 就注册成裸名 `dsh-fail-soft` ——
> 那样 DSH 会按 `@lanbaolu/dsh-fail-soft` 找模块而找不到，启动直接
> `ERR_MODULE_NOT_FOUND` 崩溃（2026-08-19 事故根因）。
>
> 推荐使用 DSH 官方或注入器安装，它们会自动按包名注册：
> ```bash
> dsh plugin --profile web add @lanbaolu/dsh-fail-soft   # 官方 pnpm 转发
> # 或 dev_install_package(dir=<插件目录>)              # super-injector 热装配
> ```

```bash
# 手动装（务必保留完整包名，以 web profile 为例）
#    ~/.dsh/profiles/web/package.json:
#      "dependencies": { "@lanbaolu/dsh-fail-soft": "link:<本目录>" }
#      "dsh": { "profile": { "bundles": [ ..., "@lanbaolu/dsh-fail-soft" ] } }
# 2. 建 junction：node_modules/@lanbaolu/dsh-fail-soft → 本目录
# 3. 构建时已 link 运行时依赖（@deepseek-ai/dsh-app-boot、@deepseek-ai/dsh-tools
#    进本插件的 node_modules），无需额外安装。
```

## 启用 fail-soft

### 方式一：持久化开关（推荐，终端 / App 通用）

> 插件 **0.0.8+** 提供持久化开关，**App 启动（不加载 shell 环境变量）也能用**：
> 内核补丁启动时读取 `~/.dsh/fail-soft.json`，无需手动设置任何环境变量。

- **UI（0.0.10+）**：DSH 设置面板 → 「Fail-soft 隔离」区域，一键开关；
- 工具：`fail_soft_set_enabled(true)` / `fail_soft_set_enabled(false)`
- API：`POST /api/fail-soft/set-enabled`，body `{ "enabled": true }`
- 效果：写入 `~/.dsh/fail-soft.json`，**重启 dsh 后生效**；
  `fail_soft_status` 的 `switchEnabled` / `enabled` 字段反映当前开关状态。

### 方式二：环境变量（原有）

```bash
DSH_FAIL_SOFT=1 npx @deepseek-ai/dsh web          # 临时
echo 'export DSH_FAIL_SOFT=1' >> ~/.zshrc          # 永久（仅终端启动生效）
```

`DSH_FAIL_SOFT` 取值：`1|true|yes|on`。可用 `DSH_FAIL_SOFT_MODULE` 覆盖
内核加载的挂载模块（默认按包名解析本插件）。环境变量与持久化开关二者
任一开启即生效。

## 使用

- **自动隔离**：坏插件激活失败 → 诊断打印 + 写
  `- id: <entryId>\n  disabled: true`（带 `# quarantined by @lanbaolu/dsh-fail-soft`
  注释）到 profile 的 `cordis.patch.yml` → 剔除重试挂载 → 服务照常起。
- **工具**（模型可直接调用）：`fail_soft_status` / `fail_soft_list` /
  `fail_soft_restore` / `fail_soft_quarantine`。
- **HTTP API**：`GET /api/fail-soft/status`、`GET /api/fail-soft/list`、
  `POST /api/fail-soft/restore {id}`、`POST /api/fail-soft/quarantine {id,name,reason}`。
- **UI 面板**：web 会话侧栏 conversation.view 显示隔离列表与恢复按钮。
- **恢复**：修复插件后删除 patch 文件里对应条目（或用 restore 工具/UI）。

## 发布

npm 已上架：`@lanbaolu/dsh-fail-soft`（[npm 页面](https://www.npmjs.com/package/@lanbaolu/dsh-fail-soft)）。
Trusted Publishing（GitHub Actions OIDC）已配置，**打 tag 即自动发布**：

```bash
npm run build          # host 校验 + link 运行时依赖
npm run build:client   # tsdown → lib/client.js（UI 面板）
npm pack               # 检查分发 tgz 内容
# 发布（TP 自动上传）：打 tag 并 push → Actions 自动 npm publish --provenance
git tag vX.Y.Z && git push origin vX.Y.Z
# 发布成功后建 GitHub Release（附件 tgz + 说明）
gh release create vX.Y.Z lanbaolu-dsh-fail-<ver>.tgz --notes "..."
```

- 首次发布（包在 npmjs 无页面、无法先配 TP）：npmjs Access Tokens 建 token →
  真实终端 `npm publish --registry=https://registry.npmjs.org --access public --provenance=false`
  （2FA 浏览器验证；npm 非 TTY 会把授权 URL 打成 `***`，必须在真实终端跑）。
- **任何发布动作前先读发布 SOP**（记忆「npm 发布正确流程」），不要凭记忆/猜测执行。

## 构建

```bash
bash scripts/build.sh      # host 校验 + link 运行时依赖（探测 npx 缓存/DSH_DEPS_ROOT）
npm run build:client       # tsdown → lib/client.js（UI 面板）
npm pack                   # 分发 tgz
```

## 回归测试

工作目录 `防止插件错误挂不起服务/`：`fixtures/`（故意抛错的坏插件）、
`test-boot.mjs`（直接调 app-boot 验证挂载兜底与 failSoft 服务）。

## 已知边界

- 只兜"插件加载/激活失败"。profile 的 `cordis.patch.yml` 本身写坏（YAML
  语法错）仍 fail-loud——那是配置错误，不该静默。
- 每轮最多隔离一批失败插件并重试，5 轮后放弃（服务以降级树启动，不崩）。
- 挂载期自动隔离需要内核补丁 + `DSH_FAIL_SOFT=1`（崩溃在插件加载前）。
- 运行期工具/API 采用**延迟注册**：bundle 装配可能早于 `tools`/`webServer`
  服务就绪，插件会监听服务注册事件自动补注册；因此重启后 `fail_soft_*`
  工具和 `/api/fail-soft/*` 会随服务就绪自动出现，**不需要手动热重载**。
