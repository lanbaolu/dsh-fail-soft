# @lanbaolu/dsh-fail-soft

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

内核需要"fail-soft 委托插槽"补丁（极小，只做发现与委托，逻辑全在本插件）：

```bash
node patch-apply.mjs     # 见工作目录 防止插件错误挂不起服务/（sha256 校验，DSH 更新后重打）
```

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

```bash
# 1. 把本插件放进 profile 的依赖并声明 bundle（以 web profile 为例）
#    ~/.dsh/profiles/web/package.json:
#      "dependencies": { "@lanbaolu/dsh-fail-soft": "link:<本目录>" }
#      "dsh": { "profile": { "bundles": [ ..., "@lanbaolu/dsh-fail-soft" ] } }
# 2. 建 junction：node_modules/@lanbaolu/dsh-fail-soft → 本目录
# 3. 构建时已 link 运行时依赖（@deepseek-ai/dsh-app-boot、@deepseek-ai/dsh-tools
#    进本插件的 node_modules），无需额外安装。
```

## 启用 fail-soft

```bash
DSH_FAIL_SOFT=1 npx @deepseek-ai/dsh web          # 临时
echo 'export DSH_FAIL_SOFT=1' >> ~/.zshrc          # 永久
```

`DSH_FAIL_SOFT` 取值：`1|true|yes|on`。可用 `DSH_FAIL_SOFT_MODULE` 覆盖
内核加载的挂载模块（默认按包名解析本插件）。

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
