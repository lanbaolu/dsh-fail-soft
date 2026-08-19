# dsh-fail-soft 项目任务清单

> 生成时间：2026-08-19
> 来源：dsh-session-log-export/client.js 加载失败调查 + dsh-fail-soft 启动崩溃复盘
> 当前状态：崩溃根因已查清并写入 `CRASH-REPORT-2026-08-19.md`；profile 中本插件当前为 disabled；工作区有未提交改动

## 背景

本插件因“装配名与包名不一致”导致 DSH 启动崩溃（`ERR_MODULE_NOT_FOUND: Cannot find package '@lanbaolu/dsh-fail-soft'`）：

- 插件自身声明正确：`package.json` name = `cordis.patch.yml` insert name = `@lanbaolu/dsh-fail-soft`
- 崩溃时的 profile 装配用了裸名 `dsh-fail-soft`，node_modules 没有 `@lanbaolu/` 链接
- 修复方向：**插件侧不需要改名**；装配侧必须用完整包名 `@lanbaolu/dsh-fail-soft`（官方 `dsh plugin add` 或 `dev_install_package` 自动正确）

## 当前已确认状态

- [x] 根因报告已写：`CRASH-REPORT-2026-08-19.md`
- [x] README 已加“命名必须与包名一致”警告
- [x] 重启后运行期管理面漏注册问题已修复（延迟注册，见报告第七节）
- [ ] 未提交改动：`src/client/index.ts`、`lib/client.js`
- [x] 已按完整包名 `@lanbaolu/dsh-fail-soft` 装配在 profile（`dsh.profile.bundles` 中），服务当前正常运行（3080 监听）
- [x] 运行期管理面工具可用：`fail_soft_status` 返回正常（patch status=ok）
- [ ] `DSH_FAIL_SOFT=1` 的挂载兜底（mount.js）尚未实测
- [ ] 内核补丁残留/自愈高危面未处理

## 任务

### T1（P0）审查并提交当前未提交的 UI 改动

- 文件：`src/client/index.ts`、`lib/client.js`
- 操作：先 diff 确认改动内容（疑似 UI 面板改动），补充必要测试/构建，再提交
- 验收：`git status --short` 干净（除后续任务）；`npm run build` 通过

### T2（P0）按完整包名重新装配 profile 并验证不崩

- 操作：
  1. 在 `~/.dsh/profiles/web/package.json` dependencies 与 bundles 注册 `@lanbaolu/dsh-fail-soft`（或 `dev_install_package`）
  2. 确认 `node_modules/@lanbaolu/dsh-fail-soft` 链接存在
  3. 删除/绕过 cordis.patch.yml 中本插件的 disabled 条目
  4. 重启 `dsh web`
- 验收：
  - 3080 正常监听，日志无 `Cannot find package '@lanbaolu/dsh-fail-soft'`
  - `fail_soft_status` 工具可用，`/api/fail-soft/status` 返回 200
  - `DSH_FAIL_SOFT=1` 时 mount 兜底（`mount.js`）路径生效

### T3（P0）验证 fail-soft 自动隔离闭环

- 操作：人为制造一个坏插件（包名不匹配/apply 抛错）→ 重启 → 本插件自动隔离坏插件 → 其余插件照常启动 → `fail_soft_*` 恢复
- 验收：隔离条目写入 `cordis.patch.yml` 并带 `# quarantined by @lanbaolu/dsh-fail-soft` 注释；恢复后服务无需重启即可重新加载（或按产品预期重启）。

### T4（P1）处理 DSH 内核补丁残留与上游化评估

- 背景：`dsh-app-boot` 已被本插件打过补丁（`mountRootIncludeFailSoft`），插件移除后补丁残留；`heal.js` 会在 apply 时重打内核补丁，属于高危面。
- 操作：
  1. 确认当前 `~/.npm/_npx/<hash>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` 补丁状态
  2. 评估将 `mountFailSoft` 兜底逻辑上游化到 DSH 官方 `dsh-app-boot`
  3. 若暂不上游，至少在 README 显著标注“需随 DSH 版本验证补丁兼容性”
- 验收：有明确结论（上游化 PR / 或文档标注 + 验证记录）

### T5（P1）将 backup/ 目录纳入 git 管理

- 背景：`backup/` 存放原版+补丁版模板，若不入 git，新 clone 无原始锚点，heal 的“已知原始版”检测会失效。
- 操作：确认 backup 文件是否含敏感内容；加入 git 并更新 `.gitignore`
- 验收：`git status` 能看到 backup 文件被跟踪；README 说明维护方式

### T6（P2）发布新版本

- 当前 `package.json` version `0.0.6`；确认 T1/T2/T3 改动后 bump 版本并发布（`npm publish`）
- 验收：npm 包/Release 产物包含修复；tgz 内 `cordis.patch.yml` name 为完整包名

## 注意事项

- 装配本插件**必须**用完整包名 `@lanbaolu/dsh-fail-soft`，不要用目录名 `dsh-fail-soft` 或 tgz 文件名。
- 内核补丁是高危面：DSH 官方升级后必须重新验证 `fail_soft_status` 的 `patch` 字段。
