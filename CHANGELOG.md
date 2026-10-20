# 变更日志

本文件记录本插件每个版本的变更。日期格式 `YYYY-MM-DD`。

## [0.1.1] - 2026-10-21

首个公开发布版本（此前只存在于本地目录，未进 git）。本版把 0.1.1 的代码定版，并补齐全套开源发布物料：git 仓库、双语 README、HANDOFF、Release 与插件市场收录。

### 新增

- **公开发布**：仓库 <https://github.com/wjf1/dsh-plugin-usage-analytics>，可直接 `dsh plugin --profile <profile> add github:wjf1/dsh-plugin-usage-analytics`（`package.json` 声明 `dsh.bundle` + `dsh.client`，`lib/` 产物随仓库提交，无需构建）。
- `package.json` 补齐 `repository` / `homepage` / `bugs` / `author` 字段，便于市场反查来源。
- 英文 README 从六节扩写到与中文对等：配置表 9 键、HTTP/JSON-RPC 面、真机验证状态表、开发与已知限制、配图说明。
- `.gitignore`：排除 `node_modules/`、`*.bak-*`、日志与系统垃圾文件。

### 变更

- README 的推荐安装方式改为 `dsh plugin add github:…`，把原先的 `plugin_manager` 路径与手工 Junction 步骤降为离线备选。
- 构建期临时快照（`lib.bak-20261020-crashfix/`、`test.bak-20261020-crashfix/`）移出包目录，不再随仓库分发。

### 修复（0.1.1 真机修复内容，写于公开发布前）

- **致命：cordis 受限上下文读未注入服务会抛错**。`resolveProfileName` 里的 `ctx?.profile?.name` 在 `?.` 生效前就抛 `cannot get property "profile" without inject`，异常让整个 `ctx.inject` 回调中断，HTTP 路由与 `pluginAnalytics` 服务都没注册，而 fiber 又把异常吞掉，外部只看到「插件装了但没反应」。
  - 新增 `shared.safeGet(ctx, key)`（try/catch 读服务）；`index.js` 的 logger、storageDomain、baseDir 探测，`store.js` 的 storageDomain，`collector.js` 的 sessions 全部改走 `safeGet`。
  - `apply` 内的装配体抽成 `setup(scope)` 并整体 `.catch` 兜底，装配期异常至少留下一条 warn。
  - 服务发布先 `scope.provide('pluginAnalytics')` 再 `scope.set`（cordis 4 的硬要求），否则抛 `cannot set property ... without provide`。
- **同类隐患：可选链只护住一段**。`process.env.DSH_PROFILE_DIR?.replace(...).split(...)` 在变量为 `undefined` 时直接抛（真机上又一次静默装配失败），改为显式 `typeof` 判定。
- **profile 名探测过窄**。桌面宿主进程里没有 `profile` 服务、也没有 `DSH_PROFILE`，domain 名退化成 `plugin_analytics_default`，多 profile 会共用同一份数据。新增 `detectProfile(ctx, override)` 分层探测（`config.profileName` → `ctx.profile` → `app.profile` → `app.profileName` → `DSH_PROFILE` → `DSH_PROFILE_NAME` → `DSH_PROFILE_DIR` → `--profile=` 参数 → `ctx.baseDir` 的 `profiles/<name>` → 兜底 `default`），并在诊断里输出 `profileSource`。

### 新增（0.1.1 真机修复配套）

- 配置项 `profileName`（默认 `null`）：多 profile 用户在 patch 里显式指定，保证 domain 名隔离。
- 诊断接口新增 `profileSource` 字段；版本常量收敛到 `shared.VERSION`（0.1.1），诊断与 `env` 方法统一读它。
- 回归测试 4 条：`resolveProfileName` 多来源、`detectProfile` 分层与来源标注、**cordis 式受限 `Proxy` 上下文**下仍能完成装配、以及 `pluginAnalytics` 服务可读。测试总数 71 → 75。

### 验证

- `node --test`：**75/75 通过**（store 10、aggregate 11、collector 10、routes 15、rpc 18、index 11）。
- `test/verify-http.mjs`：真 `node:http` + 真 `fetch`，10/10 通过。
- 真 cordis（asar 内 `@deepseek-ai/cordis` 4.0.5）+ `ELECTRON_RUN_AS_NODE`：路由 `prefix /dsh-plugin-usage-analytics/api` 注册成功、服务 7 个键发布成功、`diagnostics()` 返回 `version 0.1.1 / profileName desktop / profileSource env.DSH_PROFILE`。
- 真宿主（`http://127.0.0.1:53853`，签名 cookie 鉴权）：`GET /` 返回 `ready:true`；`GET /overview?days=7` 返回真实数据（1181 次工具调用、22 次错误、4 个会话、tokensIn 3,354,030）；`GET /diagnostics` 显示 `storage.kind=domain`、domain `plugin_analytics_default`、`writes=158 / flushes=32`；`POST /` 的 JSON-RPC `diagnostics` 同样 200。

## [0.1.0] - 2026-10-20

首个可运行版本：宿主半（采集/存储/聚合/HTTP）+ 客户端半（侧栏面板）+ 71 条单元测试。

### 新增

- **采集**：订阅 `session/created`、`session/event`、`session/disposed`、`session/flush`，按 `WATCHED` 白名单消费 `tool/call`、`tool/result`、`turn/start`、`step/start`、`assistant/message`、`command/run`、`session/created`、`session/title`、`request/context`、`model/selection`；启动时对 `ctx.sessions.list()` 做一次回填。
- **幂等**：`meta.cursors[sid]` 游标丢弃已消费事件；fork 会话从 `inheritedEventCount` 起算；回填与实时消费共用同一游标。
- **聚合**：日表（`daily`）、工具日表（`toolDaily`）、能力日表（`capDaily`）、会话表（`sessions`）；读侧提供 `buildOverview`、`buildSeries`、`buildRecentSessions`、`buildToolDetail`。
- **存储**：每 profile 一个 domain `plugin_analytics_<profile>`，默认 `layout:'single'`，脏表 10s 合并落盘；取不到 `storageDomain` 时降级内存档。
- **HTTP**：单 prefix 路由 `/dsh-plugin-usage-analytics/api`，内部精确分派；REST 便捷端点 12 个 + 设计 §7.5 的 18 个 JSON-RPC 方法；统一信封 `{ok,value}` / `{ok:false,error:{code,message,retryable?,detail?}}`。
- **面板**：侧栏入口 + 主面板（6 KPI、14 日趋势、Top 工具、能力分布、设置区、操作区）+ 插件配置页设置区块；样式全部使用 `--dsw-alias-*` 主题 token。
- **清单**：`package.json` 补 `exports["./locale/*.json"]`、`exports["./icon"]`、`dsh.client.immediately`、`files`；新增 `locale/zh.json`、`locale/en.json`（`meta.title`/`meta.description`）与 `icon.svg`。
- **测试**：`store`(10) + `aggregate`(11) + `collector`(10) + `routes`(15) + `rpc`(18) + `index`(10) = 71 条，`node --test` 全绿。

### 修复

- `routes.js` 调用 `buildRecentSessions(store, {limit})` 形状不匹配，改为传数字。
- `collector.js` 用 `?? 'unknown'` 兜底工具名时不会跳过空串，改为 `||`。
- `openStore` 与 `apply` 只读 `ctx.get('storageDomain')`，在真实 cordis ctx 上服务是属性，改为 `ctx.storageDomain ?? ctx.get('storageDomain')`。
- `node --test test/` 在 Windows 下无法解析目录，`scripts.test` 改为显式列文件。

### 安全加固

- 围栏：`Sec-Fetch-Site` 非 `same-origin`/`none` 直接 403；存在 `Origin` 时必须与 `Host` 一致。
- 限流：写方法面每秒 10 次，超出回 `E_RATE` 429（`retryable:true`）。
- 载荷：请求体上限 64KB（超出 `E_PAYLOAD` 413），JSON 解析失败同码。
- 删除：`data.delete` 必须显式 `confirm:'DELETE'`，否则 `E_CONSENT` 403。
- 最小化：不记录消息正文/工具参数/输出/路径；会话 ID 以 `sha256(id + ':' + installId)` 截 16 位存储。
- 出站：默认 `local` 模式，代码内无任何外部网络请求。
