# HANDOFF —— 跨会话接力文档

> 新会话接手顺序：**先读本文件 → 再读 `docs/design-mapping.md` → 最后看代码**。
> 仓库：`https://github.com/wjf1/dsh-plugin-usage-analytics`（本地工作副本 `F:\AI\DeepSeek haness\workspace\dsh-plugin-usage-analytics`）。
> 本机安装方式：以 Junction 形式装进 `C:\Users\admin\.dsh\profiles\desktop\node_modules\dsh-plugin-usage-analytics`，并登记在 profile `package.json` 的 `dsh.profile.bundles`（备份：同目录 `package.json.bak-20261020-usage-analytics`）。

## 1. 项目概况与当前状态

- 目标：按设计 v1.0 实现一个可运行的 DSH 用量分析插件（采集 → 聚合 → 面板/HTTP 查询）。
- 当前状态（2026-10-21）：**0.1.1 定版、已公开发布为 `v0.1.1`，单元测试 75/75 通过、真 HTTP 栈自检 10/10、已装入 desktop profile 并在真宿主里跑通**。
  - 真宿主证据（`http://127.0.0.1:53853`，用持久 secret 自签 cookie）：`GET /` → `ready:true`；`GET /overview?days=7` → 真实数据（1181 次工具调用 / 22 次错误 / 4 个会话 / tokensIn 3,354,030 / avgMs 3505）；`GET /diagnostics` → `storage.kind=domain`、domain `plugin_analytics_default`、`writes=158`、`flushes=32`；`POST /` 的 JSON-RPC `diagnostics` 200。
  - 客户端包已出现在宿主 boot 清单里（GUI HTML 的 `plugins/??…` 列表含 `dsh-plugin-usage-analytics/client.js`），说明 `dsh.client` 注册生效；侧栏入口与面板的肉眼验收仍建议重启后由用户确认一次。
  - **注意版本差**：运行中的宿主实例加载的是 0.1.0 代码（safeGet 修复已在里面，已实测可用）；0.1.1 新增的 `detectProfile` / `profileName` / `VERSION` 需要下次重启才生效，届时 domain 名会从 `plugin_analytics_default` 变成 `plugin_analytics_desktop`（旧文件保留，不影响新数据）。
- 版本：`0.1.1`；许可 MIT。

## 2. 技术栈与运行基线

- Node：`C:\Users\admin\AppData\Local\hermes\node\node.exe`（v22.23.2）。**没有**全局 TypeScript / esbuild / tsdown / vitest，因此**不引入构建步骤**。
- 语言：纯 ESM JavaScript，`"type": "module"`；运行时零依赖，唯一内置模块引用是 `node:crypto`。
- 宿主：DSH（`dsh` 不在 PATH；`DSH_HOME=C:\Users\admin\.dsh`，`DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=C:\Users\admin\.dsh\profiles\desktop`）。
- 测试：`node --test <显式文件列表>`（目录形式在 Windows 上不可用，会报 `Cannot find module`）。

## 3. 核心架构与文件拓扑

```text
dsh-plugin-usage-analytics/
├─ package.json          # exports(./client, ./locale/*.json, ./icon) + dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # insert 一个 bundle，带 !!js 防双挂表达式
├─ icon.svg              # 展示图标（≤256KiB）
├─ locale/{zh,en}.json   # 插件列表展示元数据 meta.title / meta.description
├─ lib/
│  ├─ index.js           # apply：装配 setup(scope)、服务发布、路由注册、生命周期
│  ├─ collector.js       # 订阅会话事件、白名单、游标 + fork 边界 + 回填
│  ├─ aggregate.js       # 脏表增量聚合与读侧 builds
│  ├─ store.js           # storageDomain 封装、降级内存档、domain 单例挂 globalThis
│  ├─ routes.js          # 单 prefix 路由 + 12 个 REST 便捷端点
│  ├─ rpc.js             # 设计 §7.5 的 18 个 JSON-RPC 方法 + 信封
│  ├─ shared.js          # 常量、VERSION、safeGet、detectProfile、工具函数
│  └─ client.js          # 侧栏入口 + 面板（React，只用 --dsw-alias-* token）
├─ test/                 # 6 个 *.test.mjs + harness.mjs + verify-http.mjs
├─ docs/design-mapping.md# 设计到实现的映射与降级说明
├─ CHANGELOG.md / README.md（中英双语）/ HANDOFF.md / LICENSE
```

## 4. 最近一轮变更与交付成果

- **公开发布 v0.1.1**（2026-10-21）：建公开仓库 → 推 `main` → `git tag -a v0.1.1 -m "v0.1.1: 公开首个版本——本地用量与能力看板，75 条测试全绿"` → GitHub Release → 向 `awesome-dsh-plugin` 提收录 PR。
- 发布配套：英文 README 扩写到与中文对等（配置表、API、验证状态、开发、限制、配图说明）；`package.json` 补 `repository`/`homepage`/`bugs`/`author`；新增 `.gitignore`；构建期 `.bak-*` 快照移出包目录（移到 `F:\AI\DeepSeek haness\workspace\_trash_20261021_usage-analytics`）。
- README 推荐安装方式改为 `dsh plugin --profile <profile> add github:wjf1/dsh-plugin-usage-analytics`，手工 Junction 降为离线备选。

## 5. 待办与下一步

- [ ] 重启宿主后在 GUI 侧栏点开「用量分析」，确认面板渲染正常（当前唯一未完成的验收项，README 验证状态表里标 ⚠️）。
- [ ] 面板截图：在宿主加载插件后截 1–3 张图，放进仓库并在 `screenshots.json` 里声明（约定要求放在自己仓库，路径相对、不得含 `..`）。
- [ ] 视市场评审反馈修正条目描述或分类（现为 `usage`）。
- [ ] 可选：把 `plugins`/`env`/`events`/`report` 四个降级方法补回真实数据模型（见 `docs/design-mapping.md`）。

## 6. 关键避坑与运行约束

- **不要把包名写进 `dependencies`**：bundle 靠 `dsh.profile.bundles` 加载，加进 dependencies 会让 npm 去解析一个本地包。
- **单 prefix 路由**：宿主 `webServer.register` 同一 prefix 重复注册会抛 `duplicate prefix route` 并拖垮整棵插件树；本实现只注册一次，用 `!!js` 表达式防双挂。
- **domain 单例必须挂 `globalThis`**：HMR 会重新执行模块，局部 Map 会重复 `open` 触发 `already-open` FATAL。
- **`storageDomain` 在真实 ctx 上是属性**，测试替身只有 `ctx.get()`；两处都写 `ctx.storageDomain ?? ctx.get('storageDomain')`。
- **`tool/result` 没有工具名**：必须用 `message.toolCallId` 与 `tool/call.callId` join（`PENDING_CALLS` 有界缓存，最多 2000 条）。
- **`update()` 缺键会抛 `missing-key`**：写路径统一先 `put` 再按需 `update`。
- **客户端只 require `react`**：不要 require `@deepseek-ai/dsh-client-ui-primitives` 等宿主 Client 包（官方规范禁止），样式只用 `--dsw-alias-*` token。
- **组件别抛错**：slot 里的组件抛错会 blank 整个 slot entry（`slot entry crashed in '<slot>'`），面板所有数据读取都已 `try/catch` 并渲染错误条。
- **测试要显式列文件**；`test/harness.mjs` 的 `on()` disposer 在数组空时会删除 key（否则 `listeners.has()` 恒 true）。
- **`globalThis` 上的 domain 单例跨用例泄漏**：每个用例 setup 先 `forgetDomain('plugin_analytics_' + resolveProfileName(ctx))`。
- **发布走 GitHub API 而不是 git transport**：本机代理 7900 连不上、github.com TLS 直连被 reset，`git push` 不通；发布改用 Git Data API（blob→tree→commit→ref），效果与 push 等价。
