# 上游 v0.1.2-alpha.1 大改 → 内核补丁移植方案

> 状态：研究完成，**暂不执行/不发布**（等官方稳定版再落地，避免 alpha 迭代期返工）
> 日期：2026-08-29 ｜ 关联：官方 release `dsh-v0.1.2-alpha.1`（2026-08-27）

## 一、结论摘要

| 层面 | alpha.1 影响 | 判定 |
|---|---|---|
| **bundle 插件层**（cordis 插件部分） | cordis 4.0.1 / include 1.0.6 / loader 1.0.2 / group 1.0.1 **与 rc.2 完全同版本**，插件运行契约未变 | ✅ 兼容，无需改 |
| **内核补丁层**（heal.js → `~/.npm/_npx/`） | app-boot 产物 52.5KB→67.8KB 大改 | ❌ merge3 实测 **15 处冲突**，自动适配失败，需手工重做模板 |
| profile-boot | `installFailLoud` 调用结构未变（锚点存续） | ✅ 预期自动适配成功（源码层确认） |
| Desktop App 内核 | `app.asar.unpacked` 不在 heal.js 扫描范围（FAIL_SOFT=0，从未补丁） | ⚠️ 设计限制，Desktop 用户仅 bundle 层保护 |

**行为安全**：npx 用户升级 alpha.1 → heal 检测 needs-adaptation → **自动回滚官方原版** → DSH 正常启动，fail-soft 保护降级（不崩服务）。当前本机（Desktop App 2.0.4）与 npx rc.2 均不受影响。

## 二、上游 alpha.1 大改盘点（rc.2 → alpha.1，1079 commits）

1. **profile 模板结构重构**：`PROFILE_TEMPLATES` 从 `Record<string, string[]>` → `Record<string, ProfileTemplate>`（`{bundles, patchReload}`）；新增 `acp`/`sdk`/`sdk-minimal` profile；`DEFAULT_PROFILE_PATCH_RELOAD`（web=live，其余=startup）
2. **patch 热重载机制**：`ProfilePatchReload = 'live' | 'startup'`；新增 `watchUserPatches`（live 模式监听用户 patch 文件）
3. **模块回退重构**：`.dsh-module-fallback` 目录 + `readModuleProxyRecord`/`ensureModuleProxy`（打包可执行文件用 ESM proxy 保留安装期模块实例）；`healProfilesModuleFallback` 签名变化
4. **函数改名**：`loadUserPatchLayer` → **`loadOverlayPatches`**（含 `anchorInsertedPluginNames` 相对路径解析新增）
5. **错误报告增强**：AggregateError 展开各 entry 激活错误（`formatActivationError`）
6. **profile-boot.ts**：`composeProfile` 转 async、`createAppReady` readiness 机制、agent-presets 处理调整（SHIPPED_PRESET_ROOT 移除）
7. import 区新增 `realpathSync/rmSync/statSync/readdirSync/relative/resolve/pathToFileURL/withFileLock`

## 三、merge3 实测：15 处冲突分类

以 backup 模板（rc.8 产物，与 rc.2 零差异）+ alpha.1 构建产物实测 `adaptPatchedTemplate`：

| 类 | 数量 | 冲突示例 | 性质 |
|---|---|---|---|
| A. import 区同锚点插入 | 1 | 行 2：双方都在 `import { fileURLToPath... }` 后插 import | 可自动合（取并集，符号核对） |
| B. 官方函数改名撞补丁包装 | 1 | 行 563：官方 `loadUserPatchLayer`→`loadOverlayPatches`，补丁包装 `loadUserPatchLayerFailSoft` 引用旧名 | **必须改名**（核心） |
| C. 官方新增块与补丁块相邻锚点交错 | 13 | 行 22/27/41/65/104/188/373/385/557/1006/1067/1093 等：官方 `initProfile`/`ensureModuleProxy`/`healProfileModuleFallback` 插入点与 `loadUserPatchLayerFailSoft`/`recoverPatchFromBackups`/`quarantineEntries` 块重叠 | 需手工重新定位插入点 |

**本质**：官方在 app-boot 里做的是"profile 加载/模块解析层重构"，其插入点（文件前中段）与我们补丁的 fail-soft 防御块（loadUserPatchLayer 包装、quarantine、错误收集）位置高度重叠——diff3 无法自动裁决，必须人工重排。

## 四、补丁符号清单（移植对象）

补丁特有符号（来自 `backup/dsh-app-boot.index.js.patched`）：

- 函数：`isFailSoft`、`mountRootIncludeFailSoft`/`mountRootIncludeFailSoftImpl`、`loadUserPatchLayerFailSoft`、`quarantineEntries`、`recoverPatchFromBackups`、`writeFailSoftDiagnostic`、`failSoftHasTransientCause`、`readFailSoftSwitch`、`loadFailSoftPluginMount`、`collectLoaderEntryFailures`、`collectQuarantinableFailures`、`observeLoaderRejectionCheckpoint`
- 常量：`FAIL_SOFT_TRANSIENT_CODES`
- 增强的官方函数：`assertEntriesActivated`（profileDir 推导去 dirname）、`mountRootInclude` 调用点包装、`installFailLoud` release 注入（profile-boot 侧）

## 五、移植映射（alpha.1 新结构）

| 旧锚点（rc.2 产物） | alpha.1 新锚点 | 动作 |
|---|---|---|
| `loadUserPatchLayer(binName, patchPath)` 调用 | `loadOverlayPatches(binName, patchPath)`（产物 1127/869/878 行） | 包装函数改名 `loadOverlayPatchesFailSoft`，调用点同步 |
| `mountRootInclude` 调用（rc.2 1580 → alpha 1501） | 同函数体未变 | 包装点存续，直接复用 |
| `installFailLoud`（alpha 1368） | 签名未变（release 参数） | profile-boot 模板不动 |
| import 区 | 官方已含 `existsSync/lstatSync/mkdirSync/readFileSync/readdirSync/readlinkSync/symlinkSync/unlinkSync/writeFileSync/realpathSync/rmSync/statSync` | 补丁所需的 fs 符号官方已全覆盖，import 冲突可手动合并 |
| `assertEntriesActivated`（alpha 仍导出） | 保留 | 补丁内增强逻辑同步 |
| 大段防御块（quarantine/recover/diagnostic） | 官方 `initProfile`/`ensureModuleProxy`/`healProfileModuleFallback` 之间 | 插入点重新选择（建议放文件尾部 `boot` 之后，避开官方高频改动区） |

**关键结论**：移植不是"重跑补丁"，而是把 12 个 fail-soft 函数 + 3 处官方函数增强**重新缝合**到 alpha.1 产物上；其中唯一硬性改名是 `loadUserPatchLayerFailSoft` → `loadOverlayPatchesFailSoft`。

## 六、执行步骤（等稳定版后执行）

1. 取官方稳定版产物（npm 发布后 `npm pack @deepseek-ai/dsh-app-boot@<stable>`）
2. 更新 `backup/dsh-app-boot.index.js.orig` = 新官方产物
3. 按第五节映射，在新产物上缝合 fail-soft 防御块 → 生成新 `backup/dsh-app-boot.index.js.patched`
4. `node --check` 语法 + 静默扫描未定义引用（Do-Not-Repeat：cordis 加载前必须查）
5. `pnpm test`（adaptive-patch 单测补 alpha.1 场景）
6. 真实环境验证：隔离 DSH_HOME 临时 profile + broken-plugin 夹具，验证隔离→兜底→恢复全链路
7. 版本发布（README 同步安装命令 @版本号；awesome-dsh-plugin 条目描述已含机制说明，无需改）
8. 更新 `KNOWN_PREVIOUS_PATCHED_APP/PB` 哈希登记（平滑升级）

## 七、风险与时机

- **alpha 迭代快**（rc.2→alpha.1 仅 6 天）：现在移植 alpha.1，alpha.2/rc.3 大概率再作废 → **等 npm 稳定版一次到位**
- 期间 npx 用户升级 alpha.1 会保护降级（安全回滚）——可在 README 注明"alpha 版内核暂不保证内核层保护，bundle 层兜底照常"
- Desktop App 用户：内核层保护本就不覆盖（app.asar.unpacked 只读），长期方案是 bundle 层兜底 + 上游化评估（T4）
- **上游化窗口**：官方正在重构 boot 层（module fallback/patchReload），fail-soft 兜底逻辑上游化 PR 的窗口在稳定版前后

## 八、验证证据存档

- alpha.1 产物构建：`/tmp/dsh-upstream/packages/boot/app-boot/lib/index.js`（tsdown，67.8KB）
- merge3 冲突详情：`/tmp/upstream-scan/conflicts.json`（15 条）
- rc.2 npm 包：`/tmp/upstream-scan/`（app-boot 与 dsh tgz）
