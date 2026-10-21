/**
 * JSON-RPC 方法面测试（设计 §7.5）。
 *
 * 覆盖：方法清单、range 解析、分页/过滤、错误码到 HTTP 状态的映射、
 * 围栏拒绝、限速、以及 data.delete 的二次确认。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../lib/store.js';
import { Routes, ENDPOINTS } from '../lib/routes.js';
import { ApiError, ERROR_STATUS, createRpc, rangeToDays } from '../lib/rpc.js';
import { API_PREFIX, dayKey, resolveConfig } from '../lib/shared.js';
import { noteToolCall, noteToolResult, noteSessionFirstSeen } from '../lib/aggregate.js';
import { makeReq, makeRes } from './harness.mjs';

const DAY = dayKey(Date.now());

/** 造一个带数据的 store：3 种工具 + 一条错误。 */
function seededStore() {
  const store = createMemoryStore();
  noteToolCall(store, { day: DAY, tool: 'pwsh', cap: 'native', capKey: 'native:pwsh', ts: Date.now() });
  noteToolCall(store, { day: DAY, tool: 'pwsh', cap: 'native', capKey: 'native:pwsh', ts: Date.now() });
  noteToolCall(store, { day: DAY, tool: 'read', cap: 'native', capKey: 'native:read', ts: Date.now() });
  noteToolCall(store, { day: DAY, tool: 'mcp__fs__ls', cap: 'mcp', capKey: 'mcp:fs:ls', ts: Date.now() });
  noteToolResult(store, { day: DAY, tool: 'pwsh', ok: false, ms: 1200, ts: Date.now() });
  noteToolResult(store, { day: DAY, tool: 'read', ok: true, ms: 30, ts: Date.now() });
  noteSessionFirstSeen(store, { id: 's1', day: DAY, ts: Date.now(), model: 'x' });
  return store;
}

function makeRoutes(overrides = {}) {
  const store = overrides.store ?? seededStore();
  const settings = { ...resolveConfig(undefined), ...overrides.settings };
  const calls = { saveSettings: [], flush: 0 };
  const routes = new Routes({
    store,
    getStats: () => ({ ready: true, plugin: 'dsh-plugin-usage-analytics', version: '0.1.0', ...overrides.stats }),
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
    rateLimit: 1000,
  });
  return { store, routes, settings, calls };
}

/** 发一个 RPC，返回 { status, json }。 */
async function rpc(routes, method, params, headers = { 'sec-fetch-site': 'same-origin' }) {
  const res = makeRes();
  await routes.handle(
    makeReq({
      method: 'POST',
      url: `${API_PREFIX}/`,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ method, params }),
    }),
    res,
  );
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

test('rangeToDays：数字/字符串/对象/区间与非法值', () => {
  assert.equal(rangeToDays(7), 7);
  assert.equal(rangeToDays('30d'), 30);
  assert.equal(rangeToDays('14'), 14);
  assert.equal(rangeToDays({ days: 3 }), 3);
  assert.equal(rangeToDays(undefined, 14), 14);
  const span = rangeToDays({ from: '2026-01-01', to: '2026-01-10' });
  assert.equal(span, 10);
  assert.throws(() => rangeToDays(0), (error) => error instanceof ApiError && error.code === 'E_RANGE');
  assert.throws(() => rangeToDays(400), (error) => error.code === 'E_RANGE');
  assert.throws(() => rangeToDays('abc'), (error) => error.code === 'E_RANGE');
});

test('方法清单覆盖设计 §7.5 的 18 个方法', () => {
  const { routes } = makeRoutes();
  const expected = [
    'overview',
    'plugins',
    'plugin',
    'capabilities',
    'env',
    'series',
    'events',
    'settings.get',
    'settings.set',
    'consent.get',
    'consent.set',
    'report.preview',
    'report.now',
    'report.clear',
    'data.delete',
    'export',
    'diagnostics',
    'reset',
  ];
  for (const name of expected) assert.ok(routes.rpc.methodNames.includes(name), `缺少 ${name}`);
  assert.equal(routes.rpc.methodNames.length, expected.length);
  assert.ok(ENDPOINTS.some(([method, path]) => method === 'POST' && path === '/'));
});

test('overview：返回窗口 KPI 与工具榜', async () => {
  const { routes } = makeRoutes();
  const { status, json } = await rpc(routes, 'overview', { range: '7d' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.value.totals.toolCalls, 4);
  assert.equal(json.value.totals.toolErrors, 1);
  assert.ok(json.value.tools.length >= 3);
});

test('plugin：按 pluginId 返回逐日明细；缺参报 E_PAYLOAD', async () => {
  const { routes } = makeRoutes();
  const ok = await rpc(routes, 'plugin', { pluginId: 'pwsh', range: '7d' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.value.tool, 'pwsh');
  const bad = await rpc(routes, 'plugin', {});
  assert.equal(bad.status, ERROR_STATUS.E_PAYLOAD);
  assert.equal(bad.json.error.code, 'E_PAYLOAD');
});

test('plugins：q 过滤、排序与游标分页', async () => {
  const { routes } = makeRoutes();
  const filtered = await rpc(routes, 'plugins', { range: '7d', q: 'PWS' });
  assert.equal(filtered.json.value.rows.length, 1);
  assert.equal(filtered.json.value.rows[0].pluginId, 'pwsh');
  const all = await rpc(routes, 'plugins', { range: '7d', sort: 'name' });
  assert.equal(all.json.value.total, 3);
  assert.equal(all.json.value.rows[0].pluginId, 'mcp__fs__ls');
  assert.equal(all.json.value.nextCursor, undefined);
});

test('capabilities：type 过滤与 top 截断', async () => {
  const { routes } = makeRoutes();
  const all = await rpc(routes, 'capabilities', { range: '7d', top: 2 });
  assert.equal(all.json.value.type, 'all');
  assert.ok(all.json.value.rows.length <= 2);
  const mcp = await rpc(routes, 'capabilities', { range: '7d', type: 'mcp' });
  assert.ok(mcp.json.value.rows.every((row) => row.type === 'mcp'));
});

test('series：metric 投影与 grain 校验', async () => {
  const { routes } = makeRoutes();
  const calls = await rpc(routes, 'series', { range: '7d', metric: 'calls' });
  assert.equal(calls.json.value.metric, 'calls');
  assert.equal(calls.json.value.rows.length, 7);
  const errors = await rpc(routes, 'series', { range: '7d', metric: 'errors' });
  assert.equal(errors.json.value.rows.at(-1).value, 1);
  const bad = await rpc(routes, 'series', { range: '7d', grain: 'week' });
  assert.equal(bad.status, ERROR_STATUS.E_RANGE);
  assert.equal(bad.json.error.code, 'E_RANGE');
});

test('env / diagnostics：返回自身与存储信息', async () => {
  const { routes } = makeRoutes();
  const env = await rpc(routes, 'env', {});
  assert.equal(env.json.value.plugin.name, 'dsh-plugin-usage-analytics');
  assert.equal(env.json.value.host.node, process.version);
  const diag = await rpc(routes, 'diagnostics', {});
  assert.equal(diag.json.value.ready, true);
});

test('settings.get/settings.set：白名单与热更新', async () => {
  const { routes, settings, calls } = makeRoutes();
  const got = await rpc(routes, 'settings.get', {});
  assert.equal(got.json.value.mode, 'local');
  const set = await rpc(routes, 'settings.set', { patch: { retentionDays: 30, bad: 1 } });
  assert.equal(set.json.value.retentionDays, 30);
  assert.deepEqual(calls.saveSettings.at(-1), { retentionDays: 30 });
  assert.equal(settings.retentionDays, 30);
  const bad = await rpc(routes, 'settings.set', {});
  assert.equal(bad.status, ERROR_STATUS.E_PAYLOAD);
});

test('consent：local/off 可切，telemetry 明确拒绝', async () => {
  const { routes, settings } = makeRoutes();
  assert.equal((await rpc(routes, 'consent.get', {})).json.value.mode, 'local');
  const off = await rpc(routes, 'consent.set', { mode: 'off', version: 1 });
  assert.equal(off.json.value.mode, 'off');
  assert.equal(settings.collect, false);
  const remote = await rpc(routes, 'consent.set', { mode: 'telemetry', version: 1 });
  assert.equal(remote.status, ERROR_STATUS.E_CONSENT);
  assert.equal(remote.json.error.code, 'E_CONSENT');
});

test('report.*：未启用上报时返回空载荷', async () => {
  const { routes } = makeRoutes();
  const preview = await rpc(routes, 'report.preview', {});
  assert.equal(preview.json.value.enabled, false);
  assert.deepEqual(preview.json.value.fields, []);
  const now = await rpc(routes, 'report.now', {});
  assert.equal(now.json.value.queued, 0);
  const clear = await rpc(routes, 'report.clear', {});
  assert.equal(clear.json.value.cleared, 0);
});

test('data.delete：必须 confirm=DELETE 才真的清空', async () => {
  const { routes, store, calls } = makeRoutes();
  const denied = await rpc(routes, 'data.delete', { confirm: 'yes' });
  assert.equal(denied.status, ERROR_STATUS.E_CONSENT);
  assert.equal(store.state.tool_daily.size > 0, true);
  const done = await rpc(routes, 'data.delete', { confirm: 'DELETE' });
  assert.equal(done.json.ok, true);
  assert.equal(store.state.tool_daily.size, 0);
  assert.equal(calls.flush, 1);
});

test('export：json 与 csv 两种格式带文件名与 mime', async () => {
  const { routes } = makeRoutes();
  const json = await rpc(routes, 'export', { range: 90, format: 'json' });
  assert.match(json.json.value.name, /\.json$/);
  assert.equal(json.json.value.mime, 'application/json; charset=utf-8');
  const parsed = JSON.parse(json.json.value.content);
  assert.ok(parsed.rows.length > 0);
  const csv = await rpc(routes, 'export', { range: 90, format: 'csv' });
  assert.match(csv.json.value.content.split('\n')[0], /^kind,key,day/);
  const bad = await rpc(routes, 'export', { format: 'xml' });
  assert.equal(bad.json.error.code, 'E_RANGE');
});

test('reset：缺 confirm 拒绝，带 confirm 才清空并落盘', async () => {
  const { routes, store, calls } = makeRoutes();
  const refused = await rpc(routes, 'reset', {});
  assert.equal(refused.json.error.code, 'E_CONFIRM');
  assert.notEqual(store.state.daily.size, 0);

  const { json } = await rpc(routes, 'reset', { confirm: 'RESET' });
  assert.equal(json.value.ok, true);
  assert.equal(store.state.daily.size, 0);
  assert.equal(calls.flush, 1);
});

test('未知方法报 E_METHOD 405，缺 method 报 E_PAYLOAD', async () => {
  const { routes } = makeRoutes();
  const unknown = await rpc(routes, 'nope', {});
  assert.equal(unknown.status, 405);
  assert.equal(unknown.json.error.code, 'E_METHOD');
  const res = makeRes();
  await routes.handle(
    makeReq({ method: 'POST', url: `${API_PREFIX}/`, headers: { 'sec-fetch-site': 'same-origin' }, body: '{}' }),
    res,
  );
  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).error.code, 'E_PAYLOAD');
});

test('围栏：跨站 POST 直接 403，不进入方法分派', async () => {
  const { routes } = makeRoutes();
  const { status, json } = await rpc(routes, 'overview', {}, { 'sec-fetch-site': 'cross-site' });
  assert.equal(status, 403);
  assert.equal(json.error.code, 'E_ORIGIN');
});

test('限速：超过每秒上限回 E_RATE 429 且 retryable', async () => {
  const { store } = makeRoutes();
  const settings = { ...resolveConfig(undefined) };
  const routes = new Routes({
    store,
    getStats: () => ({}),
    settings,
    saveSettings: () => settings,
    flushNow: async () => 0,
    warn: () => {},
    rateLimit: 2,
  });
  assert.equal((await rpc(routes, 'diagnostics', {})).status, 200);
  assert.equal((await rpc(routes, 'diagnostics', {})).status, 200);
  const blocked = await rpc(routes, 'diagnostics', {});
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'E_RATE');
  assert.equal(blocked.json.error.retryable, true);
});

test('createRpc 独立可用：直接调用方法对象', async () => {
  const store = seededStore();
  const rpcApi = createRpc({
    store,
    getStats: () => ({ ready: true }),
    settings: () => ({ mode: 'local' }),
    saveSettings: () => ({ mode: 'local' }),
    flushNow: async () => 0,
  });
  const overview = await rpcApi.call('overview', { range: 1 });
  assert.equal(overview.totals.toolCalls, 4);
  const events = await rpcApi.call('events', { limit: 5 });
  assert.equal(events.degraded, 'aggregated');
});
