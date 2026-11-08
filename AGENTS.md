# AGENTS.md

本文件为 AI 代理（ZCode / Claude Code 等）提供本项目级上下文。接手任务前先通读，再读 `HANDOFF.md` 了解最新进展。

## 项目概览

DSH（DeepSeek Harness）插件用量与能力看板：本地采集会话事件、聚合为日表、面板 / HTTP / JSON-RPC 查询，**默认 local 零出站**（不发任何遥测）。

- 包名 `dsh-plugin-usage-analytics`，当前版本 **0.1.2**（2026-11-08，面板截图入仓与九项修复批次）。
- 技术栈：纯 Node ESM JavaScript（`lib/*.js`，非 TypeScript），**零运行时依赖、测试也没有 devDependencies**；Node >= 22，engines 要求 `dsh >= 0.2.0`。
- 形态：DSH bundle 插件（`cordis.patch.yml` + `dsh` manifest），web 面板经 `@deepseek-ai/dsh-client-locale` / `-ui-slots` 注入（platform web，immediately）。
- 架构要点：`lib/index.js` apply 装配 setup(scope)、服务发布、路由注册与生命周期；`routes.js` 提供 12 个 REST 便捷端点，`rpc.js` 提供设计 §7.5 的 18 个 JSON-RPC 方法 + 信封；`store.js` 含降级内存档（无 storageDomain 时可用）。
- 数据流：会话事件 → `collector.js`（白名单过滤 + 游标续读 + fork 边界处理 + 历史回填，采集回调内禁止 I/O）→ `store.js` 内存模型标脏 → 周期 flush 只写脏行（脏表为空完全跳过）→ `aggregate.js` 增量聚合出日表 → 面板 / REST / RPC 三路查询。
- 设计映射与降级口径见 `docs/design-mapping.md`（如 `plugins`/`env`/`events`/`report` 四个方法当前是降级实现，补真实数据模型前不要宣称已有数据）。
- 关键目录：`lib/store.js`（内存模型 + 脏行定时 flush 落盘）、`lib/collector.js`（采集，禁止 I/O 热路径）、`lib/aggregate.js`（日表聚合）、`lib/routes.js`（HTTP + 围栏）、`lib/rpc.js`（JSON-RPC）、`lib/client.js`（面板 UI）、`locale/*.json`（中英文案）、`test/`（node:test，6 个测试文件）、`tools/check-locale.mjs`（locale 缺 key 拦截）。

## 构建与测试命令

均已在 `package.json` scripts 与 `.github/workflows/ci.yml` 中验证真实存在（CI 明确注释：零依赖不需要 install）：

```bash
npm run check   # node --check 逐个语法校验 lib/*.js（index/routes/rpc/collector/shared/store/aggregate/client）
npm test        # node --test test/store.test.mjs test/aggregate.test.mjs test/collector.test.mjs test/routes.test.mjs test/rpc.test.mjs test/index.test.mjs
node tools/check-locale.mjs  # locale 文件缺 key 检查（缺 key 会在界面显示空字符串）
```

CI 流程（Node 22.x / 24.x 双矩阵）：check → test → check-locale。没有 build 步骤（JS 直接发布 `lib/`）。

## 代码风格约定

- 缩进 2 空格，单引号，**语句末尾不加分号**；注释密度较高，且以「为什么」为主（引用设计章节号、评审编号、真实事故），中文注释。
- 文件头 JSDoc 块注释说明模块职责与关键设计决策（见 `lib/store.js` 头部对「内存模型 + 定时 flush」的三条理由）。
- 导出常量 UPPER_SNAKE_CASE（`MAX_DAILY_ROWS` 等），跨 HMR 单例用 `Symbol.for()` 挂 `globalThis`。
- 面板客户端**只 require `react`**，禁 require 宿主 Client 包（`@deepseek-ai/dsh-client-ui-primitives` 等，官方规范禁止）；样式只用 `--dsw-alias-*` 设计令牌。
- 测试显式列出文件路径（不要 `node --test` 裸跑整目录；**目录形式在 Windows 上会报 `Cannot find module`**）；测试替身与真实 ctx 兼容写法：`ctx.storageDomain ?? ctx.get('storageDomain')`。
- `test/harness.mjs` 的 `on()` disposer 在监听数组空时会删除 key（否则 `listeners.has()` 恒 true）。

## 提交与发布规范

- 提交信息 Conventional Commits + 中文描述：`feat: ...`、`fix: ...`、`docs(panel): ...`、`chore(release): v0.1.2 定版——<摘要>`。
- 变更写 `CHANGELOG.md`（`[X.Y.Z] - YYYY-MM-DD`，中文「新增/修复」分类）；README 中英双语随功能同步修订。
- 发布：四文档（package.json / CHANGELOG / README / HANDOFF）齐备且版本一致 → `git tag -a vX.Y.Z -m "vX.Y.Z: 中文摘要"` → push tags → 建 GitHub Release（标题与 tag subject 逐字一致）。
- 注意（HANDOFF 记录）：本机 git 推送对 github.com 曾出现 TLS 直连被 reset、代理端口漂移的问题，当时发布改走 GitHub Git Data API（blob→tree→commit→ref）；推送失败时先确认本机代理实际监听端口再重试。

## 项目专属注意

1. **不要把包名写进 `dependencies`**：bundle 靠 `dsh.profile.bundles` 加载，写进 dependencies 会让 npm 去解析一个本地包。
2. **单 prefix 路由**：宿主 `webServer.register` 同一 prefix 重复注册会抛 `duplicate prefix route` 并拖垮整棵插件树；本实现只注册一次，用 `!!js` 表达式防双挂。
3. **domain 单例必须挂 `globalThis`**：HMR 会重新执行模块，局部 Map 会重复 `open` 触发 `already-open` FATAL；测试每个用例 setup 先 `forgetDomain(...)` 防跨用例泄漏。
4. **`tool/result` 事件没有工具名**：必须用 `message.toolCallId` 与 `tool/call.callId` join（`PENDING_CALLS` 有界缓存，上限 2000 条）；`update()` 缺键会抛 `missing-key`，写路径统一先 `put` 再按需 `update`。
5. **slot 组件里别抛错**：抛错会 blank 整个 slot entry；面板所有数据读取都已 `try/catch` 并渲染错误条，新增读取沿用此模式。
6. **安装方式**：推荐 `dsh plugin --profile <profile> add github:wjf1/dsh-plugin-usage-analytics`，手工 Junction 只是离线备选；本机 profile 里该包曾被 npm prune（bundles 有登记、dependencies 缺条目），补 `^0.1.x` 依赖登记后恢复——「面板 404」先查这两处登记是否都在。
7. **本机环境**：`DSH_HOME=C:\Users\admin\.dsh`、`DSH_PROFILE=desktop`，`dsh` 不在 PATH；真机验收以 DSH 0.2.1-rc.3 为基准（2026-11-01 面板全量渲染通过，截图见 `assets/panel-usage.png`）。
8. **安全基线**：HTTP 围栏先校验 `Host` 必须是回环名（防 DNS rebinding），`POST /reset` 与 JSON-RPC `reset` 均要求服务端确认令牌（`?confirm=RESET` / `params.confirm === 'RESET'`）——改路由时不要削弱这两道防线。
