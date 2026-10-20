# dsh-plugin-usage-analytics

一款给 DeepSeek Harness（DSH）用的**本地用量分析插件**：订阅会话事件，把工具调用、回合、错误、耗时与能力使用情况聚合成日表，在侧栏面板里展示，并对外提供一套本地 HTTP 查询接口。默认 **local 模式、零出站**，不采集任何消息正文。

![插件图标](icon.svg)

> 配图说明：上图是本插件随包发布的 `icon.svg`（32×32，侧栏与插件列表共用）。面板截图需要在宿主加载插件后由本机浏览器截取，见 [`docs/design-mapping.md`](docs/design-mapping.md) 的「验证状态」一节。

## 特性

- **零依赖**：纯 ESM JavaScript，只 `import` `node:` 内置模块（`node:crypto`），不需要 TS/打包工具链，装上即可跑。
- **三层幂等**：游标（`meta.cursors[sid]`）+ fork 起点（`inheritedEventCount`）+ 回填去重，重启、重载、fork 都不会重复计数。
- **脏表才写**：内存聚合 → 每 `flushIntervalMs`（默认 10s）只把脏表落盘，写放大可控。
- **可降级**：取不到 `storageDomain` 时自动切内存档，面板与接口照常工作，只是重启即丢（`diagnostics.storage.kind === 'memory'`）。
- **可关**：`collect:false` 停止采集，`selfExclude` 排除本插件的工具调用，`retentionDays` 控制保留天数（同时裁剪内存与落盘）。
- **围栏与限流**：`Sec-Fetch-Site` + `Origin`/`Host` 一致性校验，写方法面每秒 10 次上限，请求体 64KB 上限。

## 安装

正路（推荐）：

```bash
dsh plugin --profile <profile> add github:wjf1/dsh-plugin-usage-analytics
```

无需构建：`package.json` 声明了 `dsh.bundle`（`patch: ./cordis.patch.yml`）与 `dsh.client`（web UI），`lib/` 产物随仓库提交。

离线安装 / 手工等价（本机当前就是这种装法，等价于上面三步）：

1. 把包目录放进 profile 的 `node_modules`（Junction 或直接拷贝）：
   `C:\Users\admin\.dsh\profiles\desktop\node_modules\dsh-plugin-usage-analytics`
2. 在 profile 的 `package.json` 的 `dsh.profile.bundles` 数组里追加 `"dsh-plugin-usage-analytics"`（**不要**加进 `dependencies`，bundle 不需要 npm 解析）。
3. 重启 DSH（**新增 bundle 可以靠 HMR 加载，替换已装包必须重启**；本仓库采用 Junction，改动即时可见但首次加载仍需宿主扫到 bundle 列表）。

装好后打开侧栏「用量分析」即可看到面板；`GET /dsh-plugin-usage-analytics/api/` 应返回 `{"ok":true,"value":{"ready":true,...}}`。

## 配置

写在 `cordis.patch.yml` 的 `config` 段（也可在运行时通过设置接口热改，仅白名单键）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `local` | `local` 只落本地；`remote`/`opt-in` 为未来上报预留，当前不产生任何出站流量 |
| `collect` | `true` | 总开关，`false` 时不再消费会话事件 |
| `sampleRate` | `1` | 采样率（0..1），按 `tool/call`+`tool/result` 成对抽稀，丢弃量记在 `meta.sampled` |
| `retentionDays` | `90` | 保留天数（1..400），定时任务按此裁剪 |
| `maxEventsPerDay` | `200000` | 单日事件上限，超出记 `meta.dropped` |
| `flushIntervalMs` | `10000` | 合并落盘间隔，最小 2000 |
| `layout` | `single` | 存储布局，`single` 整单元重写 / `per-record` 逐条写（小数据量更稳，大数据量注意小文件数量） |
| `selfExclude` | `false` | 是否排除本插件自身产生的调用 |
| `profileName` | `null` | 存储 domain 的 profile 后缀。默认自动探测（`config` → `profile` 服务 → `app.profile` → `DSH_PROFILE`/`DSH_PROFILE_NAME`/`DSH_PROFILE_DIR` → `--profile=` → `ctx.baseDir` 的 `profiles/<name>` → `default`），显式指定可保证多 profile 隔离 |

### 验证状态（真机）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 宿主加载 bundle | ✅ | `diagnostics.version` 有值、`routes` 注册成功 |
| HTTP 前缀可达 | ✅ | `GET /dsh-plugin-usage-analytics/api/` → `ready:true`（签名 cookie 鉴权后） |
| 真实数据聚合 | ✅ | 1181 次调用 / 22 次错误 / 4 会话 / tokensIn 3,354,030 / avgMs 3505 |
| 存储落盘 | ✅ | `storage.kind=domain`、`writes=158`、`flushes=32`、`C:\Users\admin\.dsh\storages\plugin_analytics_default.json` 14KB |
| JSON-RPC 面 | ✅ | `POST /` 的 `diagnostics` 返回统一信封 |
| 客户端包注册 | ✅ | GUI boot 清单含 `dsh-plugin-usage-analytics/client.js` |
| 面板肉眼验收 | ⚠️ | 需重启宿主后在 GUI 侧栏确认（会话内无浏览器控制权） |

## 面板

侧栏入口「用量分析」，主面板包含：

- 6 张 KPI 卡：窗口内工具调用、错误数、错误率、平均耗时、会话数、tokens 进出；
- 14 日趋势柱状图（SVG 自绘，不引第三方图表库）；
- Top 工具表（调用数、错误数、平均耗时、占比）；
- 能力分布（MCP / skill 等非原生能力的调用占比条）；
- 设置区：`collect` 勾选、`sampleRate` 滑杆、`retentionDays` 数字框；
- 操作区：刷新、立即落盘、清空本地数据（二次确认）、窗口天数切换（1/7/14/30/90）。

配色只用宿主 `--dsw-alias-*` 主题 token（带回退值），跟随浅色/深色主题。

## HTTP 接口

前缀 `API_PREFIX = /dsh-plugin-usage-analytics/api`。

### JSON-RPC 方法面（设计 §7.5）

`POST <prefix>/`，请求体 `{ "method": "...", "params": { ... } }`，响应 `{ok:true,value}` 或 `{ok:false,error:{code,message,retryable?,detail?}}`。

| method | params | 说明 |
|---|---|---|
| `overview` | `{range}` | 4 KPI + 窗口汇总 + Top 工具 |
| `plugins` | `{range,q?,sort?,cursor?}` | 工具/能力榜，每页 50 |
| `plugin` | `{pluginId,range}` | 单工具逐日明细 |
| `capabilities` | `{range,type?,top?}` | 能力排行（mcp/skill） |
| `env` | `{range}` | 宿主与插件版本、存储状态 |
| `series` | `{range,metric}` | 逐日序列（calls/errors/sessions/turns） |
| `events` | `{limit?}` | 最近会话摘要（聚合粒度，见偏差说明） |
| `settings.get` / `settings.set` | `{}` / `{patch}` | 读/改设置（白名单） |
| `consent.get` / `consent.set` | `{}` / `{mode,version}` | 同意态（只支持 local/off） |
| `report.preview` / `report.now` / `report.clear` | `{}` | 上报预览/立即/清空（未启用上报，返回空载荷） |
| `data.delete` | `{confirm:'DELETE'}` | 删除本地全部数据 |
| `export` | `{range,format:'json'\|'csv'\|'ndjson'}` | 内联导出 |
| `diagnostics` | `{}` | 运行态诊断 |
| `reset` | `{}` | 清空并重扫 |

`range` 接受数字、`"7d"`、`{days}`、`{from,to}`，上限 366 天；错误码 `E_ORIGIN/E_RATE/E_RANGE/E_PAYLOAD/E_CONSENT/E_METHOD/E_INTERNAL` 映射到设计 §7.5 的状态码表。

### REST 便捷端点（面板使用）

`GET /`、`/overview?days=`、`/series?days=`、`/sessions?limit=`、`/tools?days=`、`/tool?name=&days=`、`/settings`、`/diagnostics`、`/export`（NDJSON 下载）；`POST /settings`、`/flush`、`/reset`。与 JSON-RPC 共用同一批聚合函数。

## 存储

每个 profile 一个 domain：`plugin_analytics_<profile 名>`（`storageDomain.open`），默认 `layout: 'single'`，落盘位置由宿主的 `DSH_HOME/storages` 决定。表：

- `meta`：`installId`、`settings`、`cursors`、`dropped`、`sampled`
- `daily`：按天的总量（toolCalls/toolErrors/turns/sessions/tokens/ms）
- `toolDaily`：`day + tool` 维度
- `capDaily`：`day + 能力键` 维度（MCP / skill）
- `sessions`：会话首见与累计（turns/toolCalls/errors/model）

## 隐私

- 只记录**事件元数据**：工具名、能力分类、成败、耗时、会话短哈希、模型名、回合/步数、token 计数。
- **不记录**：消息正文、工具参数原文、工具输出、文件路径、用户名、环境变量。
- 会话 ID 以 `sha256(sessionId + ':' + installId)` 截 16 位存储，卸载重装即换新 `installId`，历史无法互相拼接。
- 默认 `local` 模式，代码里没有任何出站请求（可 `grep -R "http" lib/` 自证：只有 `http://localhost` 的 URL 解析基线）。

## 开发

无构建步骤，直接改 `lib/*.js`：

```bash
node --test test/store.test.mjs test/aggregate.test.mjs test/collector.test.mjs \
           test/routes.test.mjs test/rpc.test.mjs test/index.test.mjs
```

75 条测试全通过。`node --test test/`（只给目录）在 Windows 上会报 `Cannot find module ...\test`，必须显式列文件。

## 已知限制

见 [`docs/design-mapping.md`](docs/design-mapping.md)：设计里的 `plugins`/`env`/`events`/`report`/SDK/上报通道在本实现中是**明确降级**（数据模型不含插件清单与逐事件行），逐条列了原因与替代方案。设计 v1.0 与评审报告不在本仓库内。

## 许可证

MIT。

---

# dsh-plugin-usage-analytics (English)

A local-only usage analytics plugin for DeepSeek Harness. It subscribes to session events, aggregates tool calls, turns, errors, latencies and capability usage into daily rows, renders them in a sidebar panel, and exposes a fenced local HTTP API.

![icon](icon.svg)

## Highlights

- **Zero runtime dependencies**: plain ESM JavaScript, only `node:` builtins; no build step.
- **Idempotent ingestion**: per-session cursor + `inheritedEventCount` fork boundary + backfill dedupe.
- **Write amplification control**: in-memory aggregation, dirty tables flushed every `flushIntervalMs` (default 10s).
- **Graceful degradation**: falls back to an in-memory store when `storageDomain` is unavailable (`diagnostics.storage.kind === 'memory'`).
- **Switches**: `collect`, `selfExclude`, `sampleRate`, `retentionDays`.
- **Fence + rate limit**: `Sec-Fetch-Site`/`Origin` checks, 10 writes per second, 64KB body cap.

> Image note: `icon.svg` (32×32) ships with the package and is used by both the sidebar and the plugin list. Panel screenshots must be taken in a local browser after the host has loaded the plugin; see the "validation status" section of [`docs/design-mapping.md`](docs/design-mapping.md).

## Install

Preferred: `dsh plugin --profile <profile> add github:wjf1/dsh-plugin-usage-analytics` — `package.json` declares a `dsh.bundle` manifest (plus `dsh.client` for the web UI), so it installs with no build step.

Offline / manual equivalent:

1. Put the package directory into the profile's `node_modules` (junction or plain copy):
   `~/.dsh/profiles/<profile>/node_modules/dsh-plugin-usage-analytics`
2. Append `"dsh-plugin-usage-analytics"` to `dsh.profile.bundles` in the profile's `package.json` (**not** to `dependencies` — a bundle needs no npm resolution).
3. Restart DSH. A newly added bundle can activate through HMR; **replacing an installed package requires a restart**.

Once loaded, open "Usage Analytics" in the sidebar; `GET /dsh-plugin-usage-analytics/api/` should return `{"ok":true,"value":{"ready":true,...}}`.

## Configuration

Keys are written under `config` in `cordis.patch.yml` (whitelisted keys are also hot-editable at runtime via the settings method):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `local` | `local` keeps everything on disk; `remote`/`opt-in` are reserved for future reporting and produce no outbound traffic today |
| `collect` | `true` | Master switch; `false` stops consuming session events |
| `sampleRate` | `1` | Sampling rate (0..1), thins `tool/call`+`tool/result` pairs; drops are counted in `meta.sampled` |
| `retentionDays` | `90` | Retention window (1..400), pruned by a scheduled job |
| `maxEventsPerDay` | `200000` | Per-day event cap; overflow is counted in `meta.dropped` |
| `flushIntervalMs` | `10000` | Dirty-table flush interval, minimum 2000 |
| `layout` | `single` | Storage layout: `single` rewrites the whole unit / `per-record` writes row by row (safer for small datasets, watch the file count when data grows) |
| `selfExclude` | `false` | Exclude calls made by this plugin itself |
| `profileName` | `null` | Profile suffix for the storage domain; auto-detected by default (`config` → `profile` service → `app.profile` → `DSH_PROFILE`/`DSH_PROFILE_NAME`/`DSH_PROFILE_DIR` → `--profile=` → `profiles/<name>` under `ctx.baseDir` → `default`). Set explicitly to guarantee isolation between profiles |

## API

`POST /dsh-plugin-usage-analytics/api/` with `{method, params}` — 18 design methods: `overview`, `plugins`, `plugin`, `capabilities`, `env`, `series`, `events`, `settings.get/set`, `consent.get/set`, `report.preview/now/clear`, `data.delete`, `export`, `diagnostics`, `reset`. Convenience REST GETs back the sidebar panel. Requests are gated by `Sec-Fetch-Site` and `Origin`/`Host` consistency, capped at 10 writes per second and 64KB per body.

## Validation status (real host)

| Check | Result | Evidence |
|---|---|---|
| Bundle loaded by host | ✅ | `diagnostics.version` populated, routes registered |
| HTTP prefix reachable | ✅ | `GET /dsh-plugin-usage-analytics/api/` → `ready:true` (with signed cookie) |
| Real data aggregated | ✅ | 1181 calls / 22 errors / 4 sessions / tokensIn 3,354,030 / avgMs 3505 |
| Storage persisted | ✅ | `storage.kind=domain`, `writes=158`, `flushes=32`, a 14KB storage unit on disk |
| JSON-RPC surface | ✅ | `POST /` `diagnostics` returns the standard envelope |
| Client half registered | ✅ | GUI boot manifest lists `dsh-plugin-usage-analytics/client.js` |
| Panel eyeball check | ⚠️ | Needs a host restart, then a look at the GUI sidebar |

## Development

No build step — edit `lib/*.js` directly and run:

```bash
node --test test/store.test.mjs test/aggregate.test.mjs test/collector.test.mjs \
           test/routes.test.mjs test/rpc.test.mjs test/index.test.mjs
```

75 tests, all passing. Passing only the `test/` directory makes `node --test` fail on Windows (`Cannot find module ...\test`) — list the files explicitly.

## Known limitations

See [`docs/design-mapping.md`](docs/design-mapping.md): the `plugins`/`env`/`events`/`report` methods, the SDK and the reporting channel are deliberately degraded in this implementation (the data model keeps no plugin list and no per-event rows); each case is listed with its reason and the substitute used instead. Design v1.0 and its review report live outside this repository.

## Privacy

Metadata only: tool name, capability class, ok/error, latency, short session hash, model name, turn/step counts, token counters. No message bodies, arguments, outputs, paths, or usernames. Local mode performs zero outbound requests.

## License

MIT.
