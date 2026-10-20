import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../lib/store.js';
import {
  buildOverview,
  buildRecentSessions,
  buildSeries,
  buildToolDetail,
  bumpDay,
  dayRow,
  noteSessionFirstSeen,
  noteSessionStats,
  noteToolCall,
  noteToolResult,
} from '../lib/aggregate.js';
import { dayKey, recentDays } from '../lib/shared.js';

const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();
const DAY = dayKey(NOW);

test('dayRow 对缺失日期返回零值，不写入', () => {
  const store = createMemoryStore();
  const row = dayRow(store, '2026-01-01');
  assert.equal(row.toolCalls, 0);
  assert.equal(store.state.daily.size, 0);
});

test('noteToolCall 同时累加日表、工具表与能力表', () => {
  const store = createMemoryStore();
  noteToolCall(store, { day: DAY, tool: 'pwsh', cap: 'native', capKey: 'pwsh', ts: NOW });
  noteToolCall(store, { day: DAY, tool: 'mcp__fs__read', cap: 'mcp', capKey: 'fs/read', ts: NOW });
  noteToolCall(store, { day: DAY, tool: 'skill', cap: 'skill', capKey: 'genui', ts: NOW });

  const daily = store.row('daily', DAY);
  assert.equal(daily.toolCalls, 3);
  assert.equal(daily.mcp, 1);
  assert.equal(daily.skills, 1);

  assert.equal(store.row('tool_daily', `${DAY}__pwsh`).calls, 1);
  assert.equal(store.row('cap_daily', `${DAY}__mcp__fs_read`).calls, 1);
  assert.equal(store.row('cap_daily', `${DAY}__skill__genui`).calls, 1);
});

test('noteToolResult 记录错误与耗时，且不覆盖调用次数', () => {
  const store = createMemoryStore();
  noteToolCall(store, { day: DAY, tool: 'pwsh', cap: 'native', capKey: 'pwsh', ts: NOW - 800 });
  noteToolResult(store, { day: DAY, tool: 'pwsh', ok: true, ms: 800, ts: NOW });
  noteToolResult(store, { day: DAY, tool: 'pwsh', ok: false, ms: 200, ts: NOW + 100 });

  const row = store.row('tool_daily', `${DAY}__pwsh`);
  assert.equal(row.calls, 1);
  assert.equal(row.errors, 1);
  assert.equal(row.samples, 2);
  assert.equal(row.ms, 1000);
  assert.equal(row.maxMs, 800);
  assert.equal(store.row('daily', DAY).toolErrors, 1);
});

test('overview 汇总窗口内数据并过滤窗口外行', () => {
  const store = createMemoryStore();
  const today = DAY;
  const old = dayKey(NOW - 40 * 86_400_000);
  for (const day of [today, old]) {
    noteToolCall(store, { day, tool: 'pwsh', cap: 'native', capKey: 'pwsh', ts: NOW });
    noteToolResult(store, { day, tool: 'pwsh', ok: day === today ? false : true, ms: 500, ts: NOW });
  }
  noteSessionFirstSeen(store, { id: 'sid1', day: today, ts: NOW, model: 'deepseek-v4' });

  const overview = buildOverview(store, { days: 7, now: NOW });
  assert.equal(overview.totals.toolCalls, 1, '窗口外(40 天前)的调用不应计入');
  assert.equal(overview.totals.toolErrors, 1);
  assert.equal(overview.totals.errorRate, 100);
  assert.equal(overview.totals.avgMs, 500);
  assert.equal(overview.today.toolCalls, 1);
  assert.equal(overview.tools[0].tool, 'pwsh');
  assert.equal(overview.tools[0].share, 100);
  assert.equal(overview.sessions, 1);
  assert.equal(overview.window.days, 7);
});

test('avgMs 无样本时返回 null（客户端显示占位符）', () => {
  const store = createMemoryStore();
  noteToolCall(store, { day: DAY, tool: 'read', cap: 'native', capKey: 'read', ts: NOW });
  const overview = buildOverview(store, { now: NOW });
  assert.equal(overview.tools[0].avgMs, null);
  assert.equal(overview.totals.avgMs, null);
});

test('series 补齐空白日期且长度等于窗口', () => {
  const store = createMemoryStore();
  bumpDay(store, DAY, { toolCalls: 5 });
  const series = buildSeries(store, { days: 7, now: NOW });
  assert.equal(series.length, 7);
  assert.equal(series[6].day, DAY);
  assert.equal(series[6].toolCalls, 5);
  assert.equal(series[0].toolCalls, 0);
});

test('recentSessions 按最后活跃倒序并受 limit 限制', () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i += 1) {
    noteSessionFirstSeen(store, { id: `s${i}`, day: DAY, ts: NOW + i * 1000 });
  }
  const rows = buildRecentSessions(store, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, 's4');
});

test('noteSessionStats 只累加已存在的会话行', () => {
  const store = createMemoryStore();
  noteSessionStats(store, { id: 'ghost', turns: 1, ts: NOW });
  assert.equal(store.row('sessions', 'ghost'), undefined);

  noteSessionFirstSeen(store, { id: 'real', day: DAY, ts: NOW });
  noteSessionStats(store, { id: 'real', turns: 2, toolCalls: 3, errors: 1, model: 'm1', ts: NOW + 10 });
  const row = store.row('sessions', 'real');
  assert.equal(row.turns, 2);
  assert.equal(row.toolCalls, 3);
  assert.equal(row.errors, 1);
  assert.equal(row.model, 'm1');
  assert.equal(row.last, NOW + 10);
});

test('buildToolDetail 返回逐日明细与窗口合计', () => {
  const store = createMemoryStore();
  noteToolCall(store, { day: DAY, tool: 'pwsh', cap: 'native', capKey: 'pwsh', ts: NOW });
  noteToolResult(store, { day: DAY, tool: 'pwsh', ok: false, ms: 300, ts: NOW });
  const detail = buildToolDetail(store, { tool: 'pwsh', days: 3, now: NOW });
  assert.equal(detail.tool, 'pwsh');
  assert.equal(detail.series.length, 3);
  assert.equal(detail.total.calls, 1);
  assert.equal(detail.total.errors, 1);
  assert.equal(detail.series[2].avgMs, 300);
});

test('recentDays 从旧到新且包含今天', () => {
  const keys = recentDays(3, NOW);
  assert.equal(keys.length, 3);
  assert.equal(keys[2], DAY);
  assert.ok(keys[0] < keys[2]);
});
