# dsh-fail-soft 启动崩溃根因调查报告

- 日期：2026-08-19
- 影响：DSH web 服务（profile `web`）启动即崩溃，3080 端口无法监听
- 状态：服务已通过从 profile bundle 中移除本插件恢复（临时止血）；本报告供项目内部 agent 修复

---

## 一、结论（TL;DR）

崩溃 **不是插件逻辑代码问题**（`lib/index.js` 可独立加载、无语法/依赖错误），而是 **打包声明与装配命名不一致** 导致的模块解析失败：

- 插件自带 `cordis.patch.yml`（经 `package.json` 的 `dsh.bundle.patch` 合入 profile）中 insert 条目的 `name: '@lanbaolu/dsh-fail-soft'`（带 scope）被 DSH 挂载器当作 **import specifier**；
- 但 profile 的装配注册名是裸名 `dsh-fail-soft`（dependencies key + bundles 条目），`node_modules` 里只有裸名链接 `node_modules/dsh-fail-soft`，**没有** `node_modules/@lanbaolu/dsh-fail-soft`；
- DSH 从 profile 目录按 `@lanbaolu/dsh-fail-soft` 解析 bare specifier → 找不到 → `ERR_MODULE_NOT_FOUND` → Cordis 启动致命失败 → 服务拉不起来。

一句话：**插件的"身份名"（`@lanbaolu/dsh-fail-soft`）和"装配名"（`dsh-fail-soft`）不一致，DSH 按身份名去找模块，但 node_modules 里只有装配名对应的链接。**

---

## 二、崩溃证据链

### 1. 崩溃错误原文

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@lanbaolu/dsh-fail-soft' imported from /Users/odis/.dsh/profiles/web/
```

- `imported from /Users/odis/.dsh/profiles/web/` —— 解析基目录是 profile 根
- 包名 `@lanbaolu/dsh-fail-soft` —— 正是插件 `package.json` 的 `name` 字段和自带 patch 里 insert 条目的 `name`

### 2. 三方命名不一致

| 位置 | 名字 | 来源 |
|---|---|---|
| 插件 `package.json` 的 `name` | `@lanbaolu/dsh-fail-soft` | 插件侧声明 |
| 插件自带 `cordis.patch.yml` insert 条目的 `name` | `'@lanbaolu/dsh-fail-soft'` | 插件侧声明 |
| profile `package.json` 的 dependencies key | `dsh-fail-soft`（裸名） | 装配侧注册 |
| profile `bundles` 条目 | `dsh-fail-soft`（裸名） | 装配侧注册 |
| `node_modules/` 里的链接 | `node_modules/dsh-fail-soft`（裸名） | npm link 按 dependencies key 创建 |

`node_modules/@lanbaolu/` 目录存在，但里面只有 `dsh-llm-verifier`、`dsh-wechat-bridge`（super-injector 注入器建的），**没有 `dsh-fail-soft`**。

### 3. 独立加载验证（排除代码问题）

```bash
cd 插件/dsh-fail-soft && node -e "import('./lib/index.js').then(m=>console.log(Object.keys(m)))"
# 输出：加载成功, exports: [ 'apply', 'name' ]
```

插件主入口、`mount.js`、`heal.js` 均正常构建（lib/ 产物齐全，Aug 19 00:32）。崩溃发生在 **bundle 装配/挂载阶段**，根本没走到插件 `apply()`。

### 4. DSH 挂载器 import 机制（dsh-app-boot 补丁版）

`mountRootInclude` 中 `HostResolvedRootInclude.import(name)`（lib/index.js:963-974）：

```js
const specifier = isAbsolute(name) ? pathToFileURL(name).href : name;
if (name.startsWith(".") || name.startsWith("cordis:")) return super.import(specifier, getOuterStack);
const internal = this.ctx.loader.internal;
return internal.import(specifier, bareModuleBaseUrl, {});   // bare specifier 从 profile 目录解析
```

即：**任何 bare specifier（如 `@lanbaolu/dsh-fail-soft`）都会从 `bareModuleBaseUrl`（profile 目录）解析**。insert 条目的 `name` 字段就是这个 specifier。`node_modules/@lanbaolu/dsh-fail-soft` 不存在 → 抛出与错误完全吻合的 `ERR_MODULE_NOT_FOUND ... imported from /Users/odis/.dsh/profiles/web/`。

### 5. 移除本插件后服务即恢复

Trae 从 profile `package.json` 移除 `dsh-fail-soft` 依赖与 bundle 注册（并在 `cordis.patch.yml` 加 `disabled: true`）后，DSH 启动正常、3080 稳定监听。证明崩溃直接由本插件的 bundle 装配触发。

---

## 三、为什么之前"修过"却没修对

git 历史（本仓库）：

- `3e4d722 fix: cordis.patch.yml entry id must be short (YAML @ is reserved char — broke bundle assembly); bump 0.0.5`
  - 只把 insert 条目的 `id` 从 `@lanbaolu/dsh-fail-soft` 改成了短 id `dsh-fail-soft`（修 YAML `@` 保留字问题）
  - **但 `name` 字段仍保留 `'@lanbaolu/dsh-fail-soft'`** —— `name` 才是被当作 import specifier 的字段，这个坑没修
- `799c2c0 fix: trim peerDependencies ... fixes ERESOLVE` —— 与本次崩溃无关

---

## 四、修复方案（插件无需改名；装配侧用完整包名，C 可作临时注入）

### 方案 A（原推荐，复查后改为**不推荐**）：把插件包名改成裸名 `dsh-fail-soft`

这是"全链路统一成裸名"的防呆思路，但**不推荐执行**：

- 插件声明本身是**正确**的：`package.json` name = `cordis.patch.yml` insert name =
  `@lanbaolu/dsh-fail-soft`，符合 DSH 规则（insert name 就是 import specifier，等于包名）。
- 官方 `dsh plugin add`、`dev_install_package`、pnpm/npm 按全名安装都会创建
  `node_modules/@lanbaolu/dsh-fail-soft`，**不会崩**（已实测 pnpm link 验证）。
- 改名需发布新包 `dsh-fail-soft`、弃用/迁移已发布的 `@lanbaolu/dsh-fail-soft`，
  对已按正确方式安装的用户是 breaking change，收益只是防"手动注册成裸名"这一种误操作。
- 真正要防的是**装配侧误用裸名**，正确动作是文档警告 + 安装流程引导，而不是改包名。

### 方案 B：装配侧 —— profile 用全名注册（不改插件，但需要用户侧操作）

profile `package.json` 的 dependencies key 与 bundles 条目都用 `@lanbaolu/dsh-fail-soft`：

```json
"dependencies": { "@lanbaolu/dsh-fail-soft": "link:/Users/odis/Desktop/Deepseek Harness/插件/dsh-fail-soft" }
```

npm 会创建 `node_modules/@lanbaolu/dsh-fail-soft` 链接，patch 的 `name` 即可解析。llm-verifier 之前就是这种装配（`@dsh-external/dsh-llm-verifier`）。**此方案依赖用户侧配置，插件侧 agent 只能把装配说明写进 README。**

### 方案 C：运行时注入（不依赖 bundle 装配，用户侧即可完成）

用 DSH super-injector 注入本插件（`dev_inject_plugin`）：注入器会在 `node_modules/@lanbaolu/` 下创建正确链接（llm-verifier、wechat-bridge 均以此方式存活），内核补丁的 mount 兜底（尝试加载 `@lanbaolu/dsh-fail-soft/mount.js`）也能命中。

### 建议

- **插件侧不需要改包名/补丁**：`package.json`、`cordis.patch.yml`、`lib/index.js`
  三处包名一致且正确。已做的加固是在 README 安装章节增加"命名必须与包名一致"的警告，
  防止再有人按目录名/tgz 文件名注册成裸名。
- 装配侧（用户/agent）**必须用完整包名 `@lanbaolu/dsh-fail-soft`** 注册；
  推荐走官方 `dsh plugin add @lanbaolu/dsh-fail-soft` 或 `dev_install_package`。
- 本次事故的 profile 已临时禁用本插件；恢复时按上述正确装配名重新加入即可。
- 若想彻底防呆，可在 DSH 官方安装器侧增强：装配本地 link 时校验 package.json name
  与 dependencies key 一致（这是 DSH 内核/CLI 的潜在改进点，非本插件缺陷）。

---

## 五、连带发现与风险（修复时一并处理）

1. **DSH 内核已被本插件打过补丁且当前仍残留**：`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` 的 md5 与仓库 `backup/dsh-app-boot.index.js.patched` 完全一致（+11KB，含 `mountRootIncludeFailSoft` 逻辑）。插件移除后补丁不会自动还原；服务当前运行正常，但建议验证补丁在无插件时的行为（它会在启动时尝试加载 `@lanbaolu/dsh-fail-soft/mount.js`，失败则回退内置循环并写 diagnostic，属防御性代码）。npx 重装/DSH 更新后补丁会消失。
2. **heal.js 会在插件 apply 时给 DSH 内核重打补丁**：这是"改内核"行为，DSH 官方更新后存在不兼容风险（虽有适配检测，但仍是高危面）。建议：
   - 将 `mountFailSoft` 兜底逻辑**上游化**到 DSH 官方内核（dsh-app-boot 正式支持），插件只做配置/管理面；
   - 或在 README 显著标注"需随 DSH 版本验证补丁兼容性"。
3. **`backup/` 目录（原版+补丁版双份文件）**建议移入 git 管理或补充说明，否则新 clone 无原始锚点，heal 的"已知原始版"检测会失效。

---

## 六、复现与验证清单

1. `npm pack` → 确认 tgz 内 `cordis.patch.yml` 的 `name` 已是修复后值
2. profile 重新 `dsh plugin install`（或 link）本插件 → 重启 `dsh web` → 3080 正常监听、日志无 `ERR_MODULE_NOT_FOUND`
3. 人为制造一个坏插件（如包名不匹配/启动抛错）→ 验证 fail-soft 自动隔离 → 其余插件照常启动 → 用 `fail_soft_*` 工具/`/api/fail-soft/*` 恢复
4. 验证 `DSH_FAIL_SOFT=1` 时 mount 兜底路径（`mount.js`）正常工作

---

## 七、2026-08-19 复查补充：重启后运行期管理面漏注册（已根治）

### 现象

重新按正确包名装配并重启后，挂载兜底（`mount.js`）正常生效、服务不崩，
但运行期管理面缺失：`fail_soft_*` 工具不可用、`/api/fail-soft/status` 404。
热重载 `dsh-fail-soft` 后恢复正常。

### 根因

本插件**不声明硬 inject**（`tools`/`webServer` 仅在可用时增强），而 Cordis
的 bundle 装配可能在 `tools`/`webServer` 服务就绪前 `apply`：

- apply 时 `ctx.get('tools')` / `ctx.get('webServer')` 为 `undefined`；
- 原代码用 `tools && ctx.effect(...)` / `webServer && ctx.effect(...)` 注册，
  服务未就绪时直接跳过，之后也不会补注册；
- 其他 bundle 插件（如 `dsh-usage-stats`）声明了 `inject: ['webServer', ...]`，
  Cordis 会等依赖服务就绪后再 apply，所以没有此问题。

### 修复

`lib/index.js` 改为**延迟注册**：

1. apply 时先 `registerIfReady()` 尝试注册；
2. 未注册完则监听 `ctx.on('internal/service')`；
3. `tools` / `webServer` 任一服务出现后立即补注册对应工具/API；
4. 幂等防重：每个服务只注册一次。

附带清理：profile `cordis.yml` 中手动残留的 `dsh-fail-soft` entry 已删除，
避免与 bundle patch 的 insert 重复对账。

验证：启动时序 mock 测试通过（无服务→0 注册、tools 就绪→4 工具、
webServer 就绪→1 API、重复触发不重复）。
