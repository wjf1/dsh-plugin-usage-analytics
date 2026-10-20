/**
 * 真 HTTP 栈集成自检（不属于单元测试套件，手动运行）。
 *
 * 目的：单元测试用的是假 req/res，这里用 `node:http` 真起一个服务、用 `fetch`
 * 真发请求，验证围栏、信封、JSON-RPC、限速与导出下载在真实 HTTP 栈上的行为。
 * 不碰宿主、不写盘、不监听公网（只绑 127.0.0.1 的随机端口）。
 */

import http from 'node:http';
import { createMemoryStore } from '../lib/store.js';
import { Routes } from '../lib/routes.js';
import { API_PREFIX, dayKey, resolveConfig } from '../lib/shared.js';
import { noteToolCall, noteToolResult, noteSessionFirstSeen } from '../lib/aggregate.js';

const DAY = dayKey(Date.now());
const store = createMemoryStore();
for (let i = 0; i < 12; i += 1) {
  const tool = i % 3 === 0 ? 'pwsh' : i % 3 === 1 ? 'read' : 'mcp__filesystem__list';
  const cap = tool.startsWith('mcp__') ? 'mcp' : 'native';
  const capKey = cap === 'mcp' ? 'mcp:filesystem:list' : `native:${tool}`;
  noteToolCall(store, { day: DAY, tool, cap, capKey, ts: Date.now() - i * 1000 });
  noteToolResult(store, { day: DAY, tool, ok: i !== 4, ms: 50 + i * 10, ts: Date.now() - i * 1000 });
}
noteSessionFirstSeen(store, { id: 'session-abc', day: DAY, ts: Date.now(), model: 'deepseek-v4' });

const settings = { ...resolveConfig(undefined) };
const routes = new Routes({
  store,
  getStats: () => ({ ready: true, plugin: 'dsh-plugin-usage-analytics', version: '0.1.0' }),
  settings,
  saveSettings: (patch) => Object.assign(settings, patch),
  flushNow: async () => store.flush(),
  warn: () => {},
  rateLimit: 1000,
});

const server = http.createServer((req, res) => {
  routes.handle(req, res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;

/** 发请求并返回 { status, json, text }。 */
async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: Object.fromEntries(response.headers) };
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
}

// 1) 健康端点
const health = await call('/');
check('GET / 返回 ready', health.status === 200 && health.json?.value?.ready === true, JSON.stringify(health.json));

// 2) REST 概览
const overview = await call('/overview?days=7');
check(
  'GET /overview 有 KPI',
  overview.json?.value?.totals?.toolCalls === 12,
  JSON.stringify(overview.json?.value?.totals),
);

// 3) JSON-RPC overview
const rpcOverview = await call('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ method: 'overview', params: { range: '7d' } }),
});
check('POST / overview', rpcOverview.json?.ok === true && rpcOverview.json.value.totals.toolCalls === 12);

// 4) JSON-RPC settings.set
const rpcSettings = await call('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ method: 'settings.set', params: { patch: { retentionDays: 45 } } }),
});
check('POST / settings.set 热更', rpcSettings.json?.value?.retentionDays === 45, JSON.stringify(rpcSettings.json));

// 5) 未知方法
const unknown = await call('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ method: 'nope' }),
});
check('未知方法 405 且带错误码', unknown.status === 405 && unknown.json?.error?.code === 'E_METHOD');

// 6) 围栏：跨站请求
const denied = await call('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  body: JSON.stringify({ method: 'diagnostics' }),
});
check('跨站请求 403', denied.status === 403 && denied.json?.error?.code === 'E_ORIGIN', JSON.stringify(denied.json));

// 7) 载荷上限
const big = await call('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ method: 'overview', params: { pad: 'x'.repeat(70 * 1024) } }),
});
check('超 64KB 判 E_PAYLOAD', big.status === 413 && big.json?.error?.code === 'E_PAYLOAD', String(big.status));

// 8) 导出下载头
const exported = await call('/export');
check(
  'GET /export 带下载头',
  exported.status === 200 && /attachment/.test(exported.headers['content-disposition'] ?? ''),
  exported.headers['content-disposition'],
);

// 9) RPC export 内联
const rpcExport = await call('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ method: 'export', params: { range: 7, format: 'csv' } }),
});
check('RPC export csv', rpcExport.json?.value?.mime === 'text/csv; charset=utf-8', rpcExport.json?.value?.name);

// 10) 404 兜底
const missing = await call('/nope');
check('未知路径 404', missing.status === 404, String(missing.status));

server.close();
const failed = results.filter((row) => !row.ok);
for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? `  → ${row.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
