import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../lib/store.js';
import { Routes, fence, ENDPOINTS } from '../lib/routes.js';
import { API_PREFIX, DEFAULTS, resolveConfig, dayKey } from '../lib/shared.js';
import { noteToolCall, noteToolResult, noteSessionFirstSeen } from '../lib/aggregate.js';
import { makeReq, makeRes } from './harness.mjs';

const NOW = Date.now();
const DAY = dayKey(NOW);

function makeRoutes(overrides = {}) {
  const store = createMemoryStore();
  const settings = { ...resolveConfig(undefined), ...overrides.settings };
  const calls = { saveSettings: [], flush: 0 };
  const routes = new Routes({
    store,
    getStats: () => ({ ready: true, ...overrides.stats }),
    settings,
    saveSettings: (patch) => {
      calls.saveSettings.push(patch);
      Object.assign(settings, patch);
    },
    flushNow: async () => {
      calls.flush += 1;
      return await store.flush();
    },
    warn: () => {},
  });
  return { store, routes, settings, calls };
}

/** 发一个请求，返回 { status, json }。 */
async function request(routes, options = {}) {
  const res = makeRes();
  await routes.handle(makeReq(options), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body };
}

const sameOrigin = { 'sec-fetch-site': 'same-origin' };

test('fence：同源放行、跨站拒绝、Origin 与 Host 不一致拒绝', () => {
  assert.equal(fence({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' } }), null);
  assert.equal(fence({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'none' } }), null);
  assert.equal(fence({ headers: { host: 'localhost:19387' } }), null);
  assert.equal(fence({ headers: { host: '[::1]:19387' } }), null);
  assert.equal(fence({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }), 'E_ORIGIN');
  assert.equal(fence({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-site' } }), 'E_ORIGIN');
  assert.equal(
    fence({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:19387' } }),
    'E_ORIGIN',
  );
  assert.equal(
    fence({ headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' } }),
    null,
  );
  assert.equal(fence({ headers: { origin: 'not a url', host: '127.0.0.1:19387' } }), 'E_ORIGIN');
});

test('fence：Host 非回环一律拒绝（DNS rebinding）', () => {
  // rebinding 场景：攻击者域名解析到 127.0.0.1，Host 与 Origin 完全一致，
  // Sec-Fetch-Site 也是 same-origin —— 只有 Host 白名单能挡住它。
  assert.equal(
    fence({ headers: { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' } }),
    'E_ORIGIN',
  );
  assert.equal(
    fence({ headers: { host: 'evil.example:19387', origin: 'http://evil.example:19387', 'sec-fetch-site': 'none' } }),
    'E_ORIGIN',
  );
  assert.equal(fence({ headers: { host: '192.168.1.10:19387' } }), 'E_ORIGIN');
  // 缺少 Host 视为不可信（HTTP/1.1 客户端一定会带）。
  assert.equal(fence({ headers: {} }), 'E_ORIGIN');
});

test('跨站请求返回 403 且信封结构正确', async () => {
  const { routes } = makeRoutes();
  const { status, json } = await request(routes, {
    url: `${API_PREFIX}/overview`,
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(status, 403);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'E_ORIGIN');
});

test('GET /overview 返回 ok 信封与窗口数据', async () => {
  const { store, routes } = makeRoutes();
  noteToolCall(store, { day: DAY, tool: 'pwsh', cap: 'native', capKey: 'pwsh', ts: NOW });
  noteToolResult(store, { day: DAY, tool: 'pwsh', ok: true, ms: 900, ts: NOW });
  noteSessionFirstSeen(store, { id: 'sid', day: DAY, ts: NOW });
  store.put('sessions', 'sid', { id: 'sid', first: NOW, last: NOW, turns: 2, toolCalls: 1, errors: 0, model: 'm' });

  const { status, json } = await request(routes, {
    url: `${API_PREFIX}/overview?days=7`,
    headers: sameOrigin,
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.value.totals.toolCalls, 1);
  assert.equal(json.value.totals.avgMs, 900);
  assert.equal(json.value.tools[0].tool, 'pwsh');
});

test('GET /series 与 /sessions 参数化', async () => {
  const { store, routes } = makeRoutes();
  noteSessionFirstSeen(store, { id: 'a', day: DAY, ts: NOW });
  const series = await request(routes, { url: `${API_PREFIX}/series?days=3`, headers: sameOrigin });
  assert.equal(series.json.value.length, 3);

  const sessions = await request(routes, { url: `${API_PREFIX}/sessions?limit=1`, headers: sameOrigin });
  assert.equal(Array.isArray(sessions.json.value), true);
  assert.equal(sessions.json.value.length, 1);
});

test('GET /tool 缺 name 返回 E_RANGE（200 信封，非 500）', async () => {
  const { routes } = makeRoutes();
  const { status, json } = await request(routes, { url: `${API_PREFIX}/tool`, headers: sameOrigin });
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'E_RANGE');
});

test('POST /settings 只接受白名单键并回写', async () => {
  const { routes, settings, calls } = makeRoutes();
  const { json } = await request(routes, {
    method: 'POST',
    url: `${API_PREFIX}/settings`,
    headers: sameOrigin,
    body: JSON.stringify({ retentionDays: 30, sampleRate: 0.25, evil: 'x', mode: 'nope' }),
  });
  assert.equal(json.ok, true);
  assert.equal(json.value.retentionDays, 30);
  assert.equal(json.value.sampleRate, 0.25);
  assert.equal(json.value.evil, undefined);
  assert.equal(json.value.mode, DEFAULTS.mode, '非法 mode 应保持默认');
  assert.deepEqual(calls.saveSettings, [{ retentionDays: 30, sampleRate: 0.25 }]);
  assert.equal(settings.retentionDays, 30);
});

test('POST /settings 没有可识别键时返回 E_PAYLOAD', async () => {
  const { routes } = makeRoutes();
  const { json } = await request(routes, {
    method: 'POST',
    url: `${API_PREFIX}/settings`,
    headers: sameOrigin,
    body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'E_PAYLOAD');
});

test('非法 JSON body 返回 E_INTERNAL 且不回显内部错误文本', async () => {
  const { routes } = makeRoutes();
  const { status, json } = await request(routes, {
    method: 'POST',
    url: `${API_PREFIX}/settings`,
    headers: sameOrigin,
    body: '{oops',
  });
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'E_INTERNAL');
  assert.equal(json.error.message, '内部错误');
});

test('不支持的方法返回 405，未知路径返回 404', async () => {
  const { routes } = makeRoutes();
  const put = await request(routes, { method: 'PUT', url: `${API_PREFIX}/overview`, headers: sameOrigin });
  assert.equal(put.status, 405);
  assert.equal(put.json.error.code, 'E_METHOD');

  const missing = await request(routes, { url: `${API_PREFIX}/nope`, headers: sameOrigin });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'E_RANGE');
});

test('POST /flush 触发落盘并返回写入行数', async () => {
  const { store, routes, calls } = makeRoutes();
  noteToolCall(store, { day: DAY, tool: 'read', cap: 'native', capKey: 'read', ts: NOW });
  const { json } = await request(routes, { method: 'POST', url: `${API_PREFIX}/flush`, headers: sameOrigin });
  assert.equal(calls.flush, 1);
  assert.equal(json.value.written > 0, true);
  assert.equal(store.dirtyCount, 0);
});

test('POST /reset 需要确认令牌，带令牌才清空并立即落盘', async () => {
  const { store, routes } = makeRoutes();
  noteToolCall(store, { day: DAY, tool: 'read', cap: 'native', capKey: 'read', ts: NOW });

  // 没有 confirm 一律拒绝：一步清空不可撤销，不能被误触/跨站打穿。
  const refused = await request(routes, { method: 'POST', url: `${API_PREFIX}/reset`, headers: sameOrigin });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, 'E_CONFIRM');
  assert.equal(store.state.daily.size, 1);

  const wrong = await request(routes, { method: 'POST', url: `${API_PREFIX}/reset?confirm=nope`, headers: sameOrigin });
  assert.equal(wrong.status, 400);
  assert.equal(store.state.daily.size, 1);

  const { json } = await request(routes, { method: 'POST', url: `${API_PREFIX}/reset?confirm=RESET`, headers: sameOrigin });
  assert.equal(json.value.reset, true);
  assert.equal(store.state.daily.size, 0);
});

test('GET /export 输出 NDJSON 且每行可解析', async () => {
  const { store, routes } = makeRoutes();
  noteToolCall(store, { day: DAY, tool: 'pwsh', cap: 'native', capKey: 'pwsh', ts: NOW });
  const res = makeRes();
  await routes.handle(makeReq({ url: `${API_PREFIX}/export`, headers: sameOrigin }), res);
  assert.match(res.headers['content-type'], /ndjson/);
  const lines = res.body.split('\n').filter((line) => line !== '');
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed.kind, 'string');
  }
});

test('GET /diagnostics 与 GET / 健康检查', async () => {
  const { routes } = makeRoutes({ stats: { mode: 'local' } });
  const health = await request(routes, { url: `${API_PREFIX}/health`, headers: sameOrigin });
  assert.equal(health.json.value.ready, true);

  const diag = await request(routes, { url: `${API_PREFIX}/diagnostics`, headers: sameOrigin });
  assert.equal(diag.json.value.ready, true);
  assert.equal(diag.json.value.mode, 'local');
});

test('端点清单非空且形如 [method, path, 说明]', () => {
  assert.ok(ENDPOINTS.length >= 10);
  for (const item of ENDPOINTS) {
    assert.match(item[0], /^(GET|POST)$/);
    assert.match(item[1], /^\//);
    assert.equal(typeof item[2], 'string');
  }
});

test('REST /sessions 的 limit 收敛到统一上限（不再被任意放大）', async () => {
  const { store, routes } = makeRoutes();
  for (let i = 0; i < 60; i += 1) {
    noteSessionFirstSeen(store, { id: `s${i}`, day: DAY, ts: NOW + i });
  }

  // 默认 20 条。
  const def = await request(routes, { url: `${API_PREFIX}/sessions`, headers: sameOrigin });
  assert.equal(def.json.value.length, 20);

  // 超过上限时按 MAX_PAGE_SIZE(200) 收敛，而不是照单全收。
  const huge = await request(routes, { url: `${API_PREFIX}/sessions?limit=1000000`, headers: sameOrigin });
  assert.equal(huge.json.value.length, 60, '返回全部 60 条，但不会因为 limit 巨大而报错或放大');

  // 非法值回退默认。
  const bad = await request(routes, { url: `${API_PREFIX}/sessions?limit=abc`, headers: sameOrigin });
  assert.equal(bad.json.value.length, 20);
});
