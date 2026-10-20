# 设计对照与偏差说明

对照对象：

- 设计：`F:\AI\DeepSeek haness\workspace\dsh-plugin-usage-analytics-design.md`（v1.0，1549 行）
- 评审：`E:\QQ\cfe30a43e35b44379287e5209093b17c.md`（401 行，P0/P1/P2 共 38 条）
- 官方插件规范：宿主内置 skill `cordis-plugin-development`（asar 内，已导出到 `%TEMP%\skill\`）

本文件回答三件事：**设计要求 ↔ 实现位置**、**哪些降级/偏差及原因**、**还剩什么没验证**。

## 1. 章节对照

| 设计章节 | 实现位置 | 说明 |
|---|---|---|
| §5 采集点（C1–C12） | `lib/collector.js` `WATCHED` | 消费 `tool/call`、`tool/result`、`turn/start`、`step/start`、`assistant/message`、`command/run`、`session/created`、`session/title`、`request/context`、`model/selection`；未消费的采集点见第 3 节 |
| §5.2 数据模型 | `lib/store.js` `TABLES` | `meta`/`daily`/`toolDaily`/`capDaily`/`sessions` 五张表；设计里的 `plugin_*`/`env`/`survey`/`report_*` 表未建（无数据源） |
| §5.3 事件行 schema | — | **未实现**：本实现不做逐事件落库，直接聚合成日表（见 3.1） |
| §6.1–6.2 采集/聚合流 | `lib/collector.js` → `lib/aggregate.js` → `lib/store.js` | 事件 → 内存 → 脏表 → 10s 落盘 |
| §6.3 三条硬约束 | `lib/collector.js` `guard`/`consume`、`lib/index.js` | ①不阻塞 turn（回调内只做同步内存操作，落盘异步）②不抛异常（`guard` 全包 try/catch，cordis emit stop-on-throw）③不改会话（从不 append 事件） |
| §6.4 采样 | `lib/collector.js` `sampleRate` | 成对抽稀 `tool/call`+`tool/result`，丢弃计入 `meta.sampled` |
| §6.5 状态机 / §6.6 上报时机 | — | 未实现上报通道（见 3.4） |
| §7.1 包契约 | `package.json` | `exports` 含 `.`/`./client`/`./locale/*.json`/`./icon`；`dsh.bundle.patch`、`dsh.client{platform,immediately,inject}`、`dsh.manifestVersion`；`files` 列全 |
| §7.2 配置/注入 | `lib/shared.js` `DEFAULTS`/`resolveConfig`、`lib/index.js` `inject(['webServer'])` | 可调参数全部来自配置；服务按需 `ctx.inject` |
| §7.3 服务接口 | `lib/index.js` `scope.set('pluginAnalytics', …)` | 只暴露 `snapshot/flush/diagnostics/defaults`，未实现 `track/pluginState/consent/deleteLocalData/export/onEvent` 的完整对象形态（见 3.5） |
| §7.4 第三方 SDK | — | **未实现**（`globalThis.__dshPluginAnalytics.track` 白名单 + 令牌桶），见 3.6 |
| §7.5 JSON-RPC | `lib/rpc.js` + `lib/routes.js` `handleRpc` | 18 个方法全部可调用；错误码 `E_ORIGIN/E_RATE/E_RANGE/E_PAYLOAD/E_CONSENT/E_METHOD/E_INTERNAL` 映射状态码 |
| §7.6 上报协议 | — | 未实现（local-only） |
| §7.7 作者侧 API | — | 未实现（无后端） |
| §7.8 设置项 | `lib/routes.js` `SETTING_RULES` | 暴露 6 项：`mode/retentionDays/sampleRate/collect/panelEnabled/selfExclude`；设计里的 `enabled/panelVisible/collectPaths/reportEnabled/saltId/…` 未全量暴露（见 3.7） |
| §8.1 写入路径 | `lib/store.js` `flush()` | 单写链、脏表合并、`single` 布局整单元原子重写（宿主 temp+fsync+rename） |
| §8.2 rollup | `lib/aggregate.js` `bump*` | 幂等累加 + `put` 覆盖同日行；不做逐事件重放式 rollup |
| §8.3 查询 | `lib/aggregate.js` `build*` | 只读内存，纯函数，无 I/O |
| §8.4 保留期 | `lib/store.js` `prune(retentionDays)` | 定时（每小时）裁剪；同时清 `daily`/`toolDaily`/`capDaily`/`sessions` |
| §8.5 容量 | `lib/shared.js` `MAX_DAILY_ROWS`/`MAX_SESSION_ROWS` | 行数上限 + 单日事件上限 `maxEventsPerDay` |
| §8.6 reconcile | — | 简化为「重启回填 + 游标幂等」，未做全量对账 |
| §9 页面交互 | `lib/client.js` | 侧栏 + 主面板 + 设置区块；6 KPI/趋势/Top 工具/能力/设置/操作 |
| §10 导出 | `lib/rpc.js` `export`、`lib/routes.js` `GET /export` | `json`/`csv`/`ndjson` 内联返回（无 jobId 异步导出） |
| §11 隐私 | `lib/shared.js` `shortHash`、`lib/collector.js` | 只存元数据；会话短哈希；零出站 |
| §12 SLO | — | 未做可观测的 SLO 断言 |
| §13 配置链 / kill switch | `lib/shared.js` `resolveConfig` + `settings` 热更 | `collect:false` 即 kill switch |
| §14 安全围栏 | `lib/routes.js` `fence` + `allowRate` | 三层里实现了 `Sec-Fetch-Site` 与 `Origin`/`Host`；首屏一次性 token 见 3.8 |
| §15 降级/迁移 | `lib/index.js` 降级内存档；`lib/store.js` `meta.schema` | 存储不可用时降级；未实现跨版本迁移器 |
| §16 边界 B01–B28 | 分散：`collector.guard`、`store.TABLES` 归一化、`rpc.rangeToDays` | 关键边界：坏值回默认、区间上限、载荷上限、未就绪 |
| §17 验收 A-01–A-39 | `test/` 71 条 | 覆盖面见第 4 节 |
| §18 里程碑 | 本次交付 = M0–M3 + 部分 M4 | 未做 M5 的发布流程 |
| §19 交付物 | 本仓库 `README/CHANGELOG/HANDOFF/docs` | 缺 `LICENSE` 实体文件（README 声明 MIT） |

## 2. 评审 P0/P1 的落实

| 评审项 | 落实 |
|---|---|
| P0-1 `tool/result` 无工具名 | `collector.js` 用 `callId` → `PENDING_CALLS` 有界映射（2000 条）join；超限 LRU 丢弃并计 `dropped` |
| P0-2 无 batch/replace | 写路径逐表 `put`，脏表合并后一次 flush；未依赖不存在的批量 API |
| P0-3 per-profile domain | `plugin_analytics_<profile>`，`detectProfile()` 九级来源探测（`config.profileName` → `profile` 服务 → `app.profile` → 环境变量 → `--profile=` → `baseDir`），诊断输出 `profileSource`；单 profile 下回退 `default` 仍可工作 |
| P0-5 `inject` 即必需依赖 | 只用 `ctx.inject(['webServer'], …)` 包裹，缺服务时不影响其它插件 |
| P0-7 每 profile 一 domain | 见 P0-3 |
| P0-9 增量 rollup | 内存增量累加，不做全量重放 |
| P0-11 无 apply 时序钩子 | 不依赖"插件加载完成"时序；`session/created` + `sessions.list()` 回填 |
| P1-5 围栏 | `Sec-Fetch-Site` + `Origin`/`Host`，见 3.8 关于 token 的取舍 |
| P1-9 错误用 200 + body | 业务错误默认 200；围栏/限速/载荷用真实状态码并**同时**带 `error` 对象 |
| P1-12 无 CSRF token 先例 | 不实现 token（P2 降级），文档注明 |

## 3. 偏差与降级（逐条原因）

### 3.1 不做逐事件落库（`events` 方法降级）

设计要求 `events` 返回 `Paged<EventRow>`、`report.preview` 给出字段级样本。本实现直接把事件折进日表与会话表，**没有逐事件行**。

- 原因：20 万事件/天的逐条落盘会带来巨大写放大（每写一次 `single` 布局整单元重写），评审 P0-2 也指出无批量接口。
- 现状：`events` 返回最近会话摘要（`kind:'session'`，含 first/last/turns/toolCalls/errors/model），并带 `degraded:'aggregated'` 显式标记。

### 3.2 `plugins`/`plugin`/`env` 的"插件"维度

设计要求以**插件**（bundle）为维度列榜与详情，数据来自能力注册表。本实现没有能力注册表数据源（宿主 loader 的内部结构不是稳定契约，且官方规范反对绕开 loader 读取）。

- 现状：`plugins`/`plugin` 以**工具名**为 `pluginId` 维度（`source` 字段给出 `builtin`/`mcp`/`skill`）；`env` 只返回宿主 Node/平台/profile 与自身版本，并在 `note` 字段里说明"未采集第三方插件清单"。

### 3.3 `capabilities` 只覆盖非原生能力

`capDaily` 只对 MCP/skill 记账（原生化工具在 `toolDaily` 里），因此 `capabilities` 不返回 `type:'tool'` 行。这是刻意的：原生工具已有 Top 工具表，重复列会双计。

### 3.4 上报通道（`report.*`、`consent` telemetry 档）未实现

设计要求 `local`/`telemetry` 双模、字段级预览、gzip + HMAC 上报。本实现**默认 local 且完全不出站**。

- 现状：`consent.set` 只接受 `local`/`off`，传 `telemetry` 明确回 `E_CONSENT`；`report.preview` 返回 `{fields:[],bytes:0,enabled:false}`；`report.now`/`report.clear` 返回 `{enabled:false}` 的空载荷。
- 原因：上报涉及作者后端与密钥管理，超出"本地可运行插件"的交付范围；先把接口面留好，避免以后改前端契约。

### 3.5 服务对象不完整

设计要求 `AnalyticsService` 有 8 个方法。本实现只 `scope.set('pluginAnalytics', {name, mode, ready, snapshot, flush, diagnostics, defaults})`。

- 原因：`track`（第三方自报）、`onEvent`、`pluginState`、`consent`、`deleteLocalData`、`export` 在服务对象上属于"对外扩展点"，暂时通过 HTTP 方法面提供等价能力，避免两套语义。

### 3.6 SDK 未实现

设计 §7.4 的 `dsh-plugin-usage-analytics/sdk`（零依赖 `track()` + `isEnabled()` + 白名单 + 令牌桶）未交付。

- 原因：先落地采集主链路；SDK 需要宿主端白名单文件与令牌桶，属于独立小版本。

### 3.7 设置项少于设计

设计 §7.8 列出十余项。本实现暴露 `mode/retentionDays/sampleRate/collect/panelEnabled/selfExclude` 六项（`SETTING_RULES` 白名单校验）。

- 原因：其余项（`collectPaths`、`reportEndpoint`、`saltId`、`ui.*` 等）依赖未实现的上报/SDK 子系统，提前暴露会变成"能改但不生效"的空开关。

### 3.8 首屏一次性 token 未实现

设计 §14.2-4 要求 `X-DSH-Analytics-Token` 首屏注入。参考件取证显示 DSH 只有 Host→`Sec-Fetch-Site`→`Origin` 三层，**没有 CSRF token 与首屏注入先例**，评审也建议降为 P2。

- 现状：不实现 token；围栏只做三层中的可落地部分，并在 `diagnostics.fence` 里返回实际启用项，便于排查。

### 3.9 面板走 REST 而非 JSON-RPC

设计上面板应调用 `POST <prefix>/` 的 JSON-RPC。本实现面板用只读 GET（`/overview`、`/series`、`/settings`）。

- 原因：手写客户端、零依赖，REST GET 代码量更小且便于缓存排查；JSON-RPC 已完整实现并有测试，切换成本很低（`useAnalytics` 里改一个函数）。

### 3.10 布局默认 `single`

设计要求 per-profile domain + 可切布局。本实现默认 `layout:'single'`（防 2 万小文件拖慢 `open`），`per-record` 可通过配置切换但**未在真机上验证**。

### 3.11 profile 名探测：宿主进程里拿不到 `profile` 服务

真机诊断显示 `profileName:'default'`，而 `C:\Users\admin\.dsh\profiles` 下实际有 `desktop` 与 `web` 两个 profile。原因：桌面宿主进程既没有暴露 `profile` 服务，也没有 `DSH_PROFILE` 环境变量；在 asar 全量 grep `DSH_PROFILE` 命中 0 个文件，说明宿主不是靠该变量选 profile。

- 现状：`detectProfile()` 按九级来源依次尝试，命中谁就记 `profileSource`（诊断里可见）。在真 cordis 探针里命中 `env.DSH_PROFILE`；在桌面宿主里若全部落空则回退 `default`。
- 兼容：domain 名从 `plugin_analytics_default` 变为 `plugin_analytics_desktop` 后，旧文件不会被读取（历史数据留在原文件，不迁移）；需要合并时把 `profileName` 显式写成 `default` 即可继续读旧数据。
- 该问题也是评审 P0-7「多 profile 共享 storages 会互相覆盖」的最后一环：**有了显式 `profileName` 配置就不再依赖自动探测**。

## 4. 验收覆盖（对应设计 §17）

| 验收项 | 测试 |
|---|---|
| 采集与幂等（A-01/02/03） | `collector.test.mjs`：游标丢弃、fork 起点、回填不重计 |
| 聚合正确（A-05/06） | `aggregate.test.mjs`：日表累加、错误率、Top 排序、占比 |
| 存储降级（A-09） | `index.test.mjs`：`storageDomain` 抛错 → `storage.kind === 'memory'` |
| 围栏（A-20/21） | `routes.test.mjs`：跨站 403、Origin 不一致 403 |
| 载荷上限（A-22） | `routes.test.mjs`：>64KB → `E_PAYLOAD` |
| 错误码（A-25） | `rpc.test.mjs`：`E_METHOD`/`E_PAYLOAD`/`E_RANGE`/`E_CONSENT`/`E_RATE` |
| 删除二次确认（A-28） | `rpc.test.mjs`：`confirm:'DELETE'` |
| 保留期裁剪（A-30） | `store.test.mjs`：`prune` 后旧行消失 |
| 设置热更（A-31） | `routes.test.mjs` + `rpc.test.mjs`：白名单 + 越界回退 |
| 未就绪（A-36） | `index.test.mjs`：`GET /` 返回 `ready:true` |
| profile 隔离（P0-3/P0-7） | `index.test.mjs`：`detectProfile` 九级来源与 `profileSource`；cordis 式受限 `Proxy` 读未注入服务时不中断装配 |

未覆盖：真实宿主下的 HMR/重启行为、面板视觉、`per-record` 布局、长跑内存曲线、多会话并发写。

## 5. 验证状态（重要）

- ✅ 单元/集成测试：`node --test` **75/75 通过**（store 10 + aggregate 11 + collector 10 + routes 15 + rpc 18 + index 11）。
- ✅ 真 HTTP 栈：`test/verify-http.mjs` 起真 `node:http` 用真 `fetch` 打完整请求，10/10 通过。
- ✅ 客户端包加载：假 window + 假 React 跑 `__ModuleLoader__.load` 与 `apply`，三个插槽注册、zh/en 字典全部就位。
- ✅ 清单自检：`package.json` 的 `exports`/`files`/`dsh.*` 字段与官方 skill 要求逐条对齐。
- ✅ **真宿主已跑通**（`http://127.0.0.1:53853`，用 `C:\Users\admin\.dsh\.credentials.yaml` 里的持久 secret 自签签名 cookie 鉴权）：
  - `GET /dsh-plugin-usage-analytics/api/` → `ready:true`；
  - `GET …/overview?days=7` → `toolCalls:1181`、`toolErrors:22`、`sessions:4`、`tokensIn:3354030`、`avgMs:3505`；
  - `GET …/diagnostics` → `storage.kind=domain`、`writes=158`、`flushes=32`、`rows={daily:2,tool_daily:45,sessions:4}`；
  - `POST /`（JSON-RPC `diagnostics`）→ 200 统一信封。
  - 落盘证据：`C:\Users\admin\.dsh\storages\plugin_analytics_default.json`（14467B）。
- ✅ 客户端注册证据：GUI 首页 HTML（510499B）的 `__DSH_BOOT__` 模块清单里含 `dsh-plugin-usage-analytics/client.js`。
- ⚠️ **面板肉眼外观**：本会话不具备浏览器控制权、按官方 skill 要求也不得自起浏览器截图，侧栏入口与面板的视觉验收留给用户在 GUI 里确认。
- ⚠️ **版本差**：运行中的宿主实例加载的是 0.1.0（`safeGet` 修复已包含在内，真机数据即来自它）；0.1.1 的 `detectProfile`/`profileName`/`VERSION` 需下次重启生效。

