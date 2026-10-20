/**
 * 聚合层：把"事实"并入内存模型（写侧），以及把模型投影成查询结果（读侧）。
 *
 * 写侧一律通过 store.put 标脏，不做 I/O；
 * 读侧只读 store.state，返回新对象，绝不把内部引用漏给路由层。
 */

import { avgMs, num, pct, recentDays, str, uint } from './shared.js';

/** 取一天的日总行（不存在则零值，不落盘）。 */
export function dayRow(store, day) {
  return store.row('daily', day) ?? {
    day,
    events: 0,
    toolCalls: 0,
    toolErrors: 0,
    steps: 0,
    turns: 0,
    sessions: 0,
    tokensIn: 0,
    tokensOut: 0,
    ms: 0,
    msSamples: 0,
    maxMs: 0,
    panels: 0,
    commands: 0,
    mcp: 0,
    skills: 0,
    dropped: 0,
  };
}

/**
 * 日总表累加。
 * @param {import('./store.js').AnalyticsStore} store
 * @param {string} day
 * @param {Record<string, number>} patch 字段增量
 */
export function bumpDay(store, day, patch) {
  const row = { ...dayRow(store, day), day };
  for (const [field, delta] of Object.entries(patch)) {
    if (typeof delta === 'number' && Number.isFinite(delta)) {
      row[field] = Math.max(0, num(row[field]) + delta);
    }
  }
  store.put('daily', day, row);
  return row;
}

/**
 * 记录一次工具调用（在 tool/call 时调用，负责计数）。
 * @param {import('./store.js').AnalyticsStore} store
 * @param {object} fact
 * @param {string} fact.day
 * @param {string} fact.tool
 * @param {'native'|'mcp'|'skill'} fact.cap
 * @param {string} fact.capKey
 * @param {number} fact.ts
 */
export function noteToolCall(store, fact) {
  const key = `${fact.day}__${safeKey(fact.tool)}`;
  const prev = store.row('tool_daily', key) ?? {
    day: fact.day,
    tool: fact.tool,
    cap: fact.cap,
    calls: 0,
    errors: 0,
    ms: 0,
    samples: 0,
    maxMs: 0,
    lastAt: 0,
  };
  store.put('tool_daily', key, {
    ...prev,
    day: fact.day,
    tool: fact.tool,
    cap: fact.cap,
    calls: prev.calls + 1,
    lastAt: fact.ts,
  });

  bumpDay(store, fact.day, { toolCalls: 1 });
  if (fact.cap === 'mcp') {
    bumpDay(store, fact.day, { mcp: 1 });
    bumpCapability(store, { day: fact.day, type: 'mcp', key: fact.capKey, ts: fact.ts });
  } else if (fact.cap === 'skill') {
    bumpDay(store, fact.day, { skills: 1 });
    bumpCapability(store, { day: fact.day, type: 'skill', key: fact.capKey, ts: fact.ts });
  }
}

/**
 * 工具结果：错误计数 + 耗时统计。
 * @param {import('./store.js').AnalyticsStore} store
 * @param {{day: string, tool: string, ok: boolean, ms: number|null, ts: number}} fact
 */
export function noteToolResult(store, fact) {
  const key = `${fact.day}__${safeKey(fact.tool)}`;
  const prev = store.row('tool_daily', key);
  const hasRow = prev !== undefined;
  const row = hasRow ? { ...prev } : {
    day: fact.day,
    tool: fact.tool,
    cap: 'native',
    calls: 0,
    errors: 0,
    ms: 0,
    samples: 0,
    maxMs: 0,
    lastAt: 0,
  };
  if (fact.ok === false) row.errors += 1;
  if (typeof fact.ms === 'number' && Number.isFinite(fact.ms) && fact.ms >= 0) {
    row.ms += Math.min(fact.ms, 24 * 3600 * 1000);
    row.samples += 1;
    row.maxMs = Math.max(row.maxMs, Math.min(fact.ms, 24 * 3600 * 1000));
    bumpDay(store, fact.day, { ms: Math.min(fact.ms, 24 * 3600 * 1000), msSamples: 1 });
  }
  row.lastAt = Math.max(row.lastAt, fact.ts);
  store.put('tool_daily', key, row);
  if (fact.ok === false) bumpDay(store, fact.day, { toolErrors: 1 });
}

/** 能力日表（mcp / skill 维度）累加一次调用。 */
export function bumpCapability(store, { day, type, key, ts }) {
  const rowKey = `${day}__${type}__${safeKey(key)}`;
  const prev = store.row('cap_daily', rowKey) ?? {
    day,
    type,
    key,
    calls: 0,
    errors: 0,
    lastAt: 0,
  };
  store.put('cap_daily', rowKey, { ...prev, day, type, key, calls: prev.calls + 1, lastAt: ts });
}

/**
 * 会话首次出现：建行 + 当日会话数 +1。
 * @param {import('./store.js').AnalyticsStore} store
 * @param {{id: string, day: string, ts: number, model?: string}} fact
 */
export function noteSessionFirstSeen(store, fact) {
  const prev = store.row('sessions', fact.id);
  if (prev !== undefined) {
    store.put('sessions', fact.id, { ...prev, last: Math.max(prev.last, fact.ts) });
    return false;
  }
  store.put('sessions', fact.id, {
    id: fact.id,
    first: fact.ts,
    last: fact.ts,
    turns: 0,
    toolCalls: 0,
    errors: 0,
    model: str(fact.model, 80),
  });
  bumpDay(store, fact.day, { sessions: 1 });
  return true;
}

/**
 * 会话累计计数（turns / 工具调用 / 错误 / 模型名）。
 * 行不存在时静默返回：会话行由 noteSessionFirstSeen 负责创建。
 */
export function noteSessionStats(store, { id, turns = 0, toolCalls = 0, errors = 0, model = '', ts }) {
  const prev = store.row('sessions', id);
  if (prev === undefined) return;
  store.put('sessions', id, {
    ...prev,
    turns: prev.turns + turns,
    toolCalls: prev.toolCalls + toolCalls,
    errors: prev.errors + errors,
    model: str(model, 80) || prev.model,
    last: Math.max(prev.last, num(ts)),
  });
}

/** 主键安全化：与 store.keyPart 同规则，避免两处不一致。 */
function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 110) || '_';
}

// ── 读侧 ────────────────────────────────────────────────────────────────────

/** 概览：KPI + 今日/近 7 日对比 + Top 工具。 */
export function buildOverview(store, { days = 7, topTools = 8, now = Date.now() } = {}) {
  const span = Math.max(1, Math.min(90, Math.floor(days)));
  const keys = recentDays(span, now);
  const total = { toolCalls: 0, toolErrors: 0, turns: 0, sessions: 0, tokensIn: 0, tokensOut: 0, ms: 0, msSamples: 0, mcp: 0, skills: 0, steps: 0 };
  let today = null;
  for (const day of keys) {
    const row = store.row('daily', day);
    if (row === undefined) continue;
    for (const field of Object.keys(total)) total[field] += num(row[field]);
    if (day === keys[keys.length - 1]) today = row;
  }
  const toolTotals = new Map();
  for (const [key, row] of store.state.tool_daily) {
    const day = str(row?.day, 10);
    if (day === '' || !keys.includes(day)) continue;
    const name = str(row.tool, 120) || key;
    const acc = toolTotals.get(name) ?? { tool: name, cap: str(row.cap, 16) || 'native', calls: 0, errors: 0, ms: 0, samples: 0, maxMs: 0 };
    acc.calls += uint(row.calls);
    acc.errors += uint(row.errors);
    acc.ms += uint(row.ms);
    acc.samples += uint(row.samples);
    acc.maxMs = Math.max(acc.maxMs, uint(row.maxMs));
    toolTotals.set(name, acc);
  }
  const tools = [...toolTotals.values()]
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
    .slice(0, Math.max(1, Math.min(50, topTools)))
    .map((item) => ({
      tool: item.tool,
      cap: item.cap,
      calls: item.calls,
      errors: item.errors,
      avgMs: avgMs(item.ms, item.samples),
      maxMs: item.maxMs,
      share: pct(item.calls, total.toolCalls),
    }));

  const last7 = recentDays(7, now);
  let last7Calls = 0;
  for (const day of last7) last7Calls += num(store.row('daily', day)?.toolCalls);

  return {
    window: { days: span, from: keys[0], to: keys[keys.length - 1] },
    totals: {
      ...total,
      errorRate: pct(total.toolErrors, total.toolCalls),
      avgMs: avgMs(total.ms, total.msSamples),
      last7Calls,
    },
    today: today
      ? {
          day: today.day,
          toolCalls: num(today.toolCalls),
          toolErrors: num(today.toolErrors),
          turns: num(today.turns),
          sessions: num(today.sessions),
          errorRate: pct(today.toolErrors, today.toolCalls),
          avgMs: avgMs(today.ms, today.msSamples),
        }
      : { day: keys[keys.length - 1], toolCalls: 0, toolErrors: 0, turns: 0, sessions: 0, errorRate: 0, avgMs: null },
    tools,
    sessions: store.state.sessions.size,
    capabilities: buildCapabilities(store, keys, 8),
  };
}

/** 能力排行（mcp / skill）。 */
export function buildCapabilities(store, keys, limit = 8) {
  const acc = new Map();
  for (const row of store.state.cap_daily.values()) {
    const day = str(row?.day, 10);
    if (day === '' || !keys.includes(day)) continue;
    const id = `${row.type}:${row.key}`;
    const item = acc.get(id) ?? { type: row.type, key: row.key, calls: 0, errors: 0 };
    item.calls += uint(row.calls);
    item.errors += uint(row.errors);
    acc.set(id, item);
  }
  return [...acc.values()].sort((a, b) => b.calls - a.calls).slice(0, Math.max(1, Math.min(50, limit)));
}

/** 逐日趋势。 */
export function buildSeries(store, { days = 14, now = Date.now() } = {}) {
  const keys = recentDays(days, now);
  return keys.map((day) => {
    const row = store.row('daily', day);
    return {
      day,
      toolCalls: num(row?.toolCalls),
      toolErrors: num(row?.toolErrors),
      turns: num(row?.turns),
      sessions: num(row?.sessions),
      avgMs: avgMs(row?.ms, row?.msSamples),
    };
  });
}

/** 最近会话（按最后活跃倒序）。 */
export function buildRecentSessions(store, limit = 20) {
  return [...store.state.sessions.values()]
    .sort((a, b) => num(b.last) - num(a.last))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((row) => ({
      id: row.id,
      first: row.first,
      last: row.last,
      turns: row.turns,
      toolCalls: row.toolCalls,
      errors: row.errors,
      model: row.model,
    }));
}

/** 工具明细（含逐日）。 */
export function buildToolDetail(store, { tool, days = 14, now = Date.now() } = {}) {
  const keys = recentDays(days, now);
  const name = str(tool, 120);
  const series = keys.map((day) => {
    const row = store.row('tool_daily', `${day}__${safeKey(name)}`);
    return { day, calls: num(row?.calls), errors: num(row?.errors), avgMs: avgMs(row?.ms, row?.samples) };
  });
  const total = series.reduce((acc, item) => ({
    calls: acc.calls + item.calls,
    errors: acc.errors + item.errors,
  }), { calls: 0, errors: 0 });
  return { tool: name, window: { from: keys[0], to: keys[keys.length - 1] }, total, series };
}
