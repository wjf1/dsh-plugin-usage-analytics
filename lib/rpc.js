/**
 * JSON-RPC 方法面（设计 §7.5：`POST <prefix>/`，body `{ method, params }`）。
 *
 * 为什么保留 REST GET（`/overview` 等）：面板是手写的零依赖客户端，
 * 直接 GET 更省代码；而 §7.5 要求的 JSON-RPC 方法面是"对外契约"，
 * 第三方脚本与未来的 SDK 依赖它。两者共用同一套聚合函数，避免双实现漂移。
 *
 * 错误模型按设计 §7.5：响应体统一 `{ ok:false, error:{ code, message, retryable, detail? } }`，
 * 同时用表里给的 HTTP 状态码（403/422/413/429/…），两者不冲突。
 */

import { buildOverview, buildRecentSessions, buildSeries, buildToolDetail } from './aggregate.js';
import { num, str, uint } from './shared.js';

/** 设计 §7.5 的错误码 → HTTP 状态。 */
export const ERROR_STATUS = Object.freeze({
  E_FENCE: 403,
  E_ORIGIN: 403,
  E_RATE: 429,
  E_RANGE: 422,
  E_PAYLOAD: 413,
  E_VERSION: 409,
  E_CONSENT: 403,
  E_NOT_READY: 425,
  E_STORAGE: 503,
  E_METHOD: 405,
  E_INTERNAL: 500,
});

/** 业务错误：路由层把它序列化成信封，不抛给宿主。 */
export class ApiError extends Error {
  /**
   * @param {string} code 错误码（ERROR_STATUS 的键）
   * @param {string} message 人类可读说明
   * @param {{ retryable?: boolean, detail?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = extra.retryable === true;
    this.detail = extra.detail;
    this.status = ERROR_STATUS[code] ?? 500;
  }
}

/** 区间上限（设计：>366 天判 E_RANGE）。 */
const MAX_RANGE_DAYS = 366;
/** plugins 方法每页行数。 */
const PAGE_SIZE = 50;
/** events 方法单页上限。 */
const MAX_EVENT_LIMIT = 200;

/**
 * 把 `range` 参数折成天数。
 * 接受：数字、`"7d"`、`"30"`、`{ days }`、`{ from, to }`；缺省回退。
 * @param {unknown} range
 * @param {number} fallback
 * @returns {number}
 */
export function rangeToDays(range, fallback = 7) {
  let days = fallback;
  if (typeof range === 'number') days = range;
  else if (typeof range === 'string' && range !== '') {
    const match = /^(\d+)\s*d?$/i.exec(range.trim());
    if (!match) throw new ApiError('E_RANGE', `无法解析 range=${range}`, { detail: { range } });
    days = Number(match[1]);
  } else if (range !== null && typeof range === 'object') {
    const record = /** @type {Record<string, unknown>} */ (range);
    if (typeof record.days === 'number') days = record.days;
    else if (typeof record.from === 'string' && typeof record.to === 'string') {
      const from = Date.parse(record.from);
      const to = Date.parse(record.to);
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
        days = Math.ceil((to - from) / 86400000) + 1;
      }
    }
  }
  const normalized = Math.floor(Number(days));
  if (!Number.isFinite(normalized) || normalized < 1 || normalized > MAX_RANGE_DAYS) {
    throw new ApiError('E_RANGE', `range 需在 1..${MAX_RANGE_DAYS} 天之间`, { detail: { range } });
  }
  return normalized;
}

/**
 * 稳定排序 + 偏移分页。
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => number | string} keyOf
 * @param {{ descending?: boolean, cursor?: number, limit?: number }} [options]
 */
function page(rows, keyOf, options = {}) {
  const limit = Math.min(PAGE_SIZE, Math.max(1, Math.floor(Number(options.limit) || PAGE_SIZE)));
  const offset = Math.max(0, Math.floor(Number(options.cursor) || 0));
  const descending = options.descending !== false;
  const sorted = [...rows].sort((a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    if (typeof left === 'number' && typeof right === 'number') return descending ? right - left : left - right;
    return descending ? String(right).localeCompare(String(left)) : String(left).localeCompare(String(right));
  });
  const slice = sorted.slice(offset, offset + limit);
  const next = offset + slice.length < sorted.length ? offset + slice.length : undefined;
  return { rows: slice, nextCursor: next, total: sorted.length };
}

/** 把聚合行导出成文本载荷。 */
function serialize(rows, format) {
  if (format === 'ndjson') {
    return {
      mime: 'application/x-ndjson; charset=utf-8',
      ext: 'ndjson',
      content: rows.map((row) => JSON.stringify(row)).join('\n'),
    };
  }
  if (format === 'csv') {
    const header = 'kind,key,day,calls,errors,ms,extra';
    const lines = [header];
    for (const row of rows) {
      lines.push(
        [row.kind, row.key, row.day, row.calls ?? '', row.errors ?? '', row.ms ?? '', JSON.stringify(row.extra ?? {})]
          .map((cell) => String(cell).replaceAll('"', '""'))
          .map((cell) => (/[",\n]/.test(cell) ? `"${cell}"` : cell))
          .join(','),
      );
    }
    return { mime: 'text/csv; charset=utf-8', ext: 'csv', content: lines.join('\n') };
  }
  return {
    mime: 'application/json; charset=utf-8',
    ext: 'json',
    content: JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), rows }, null, 2),
  };
}

/**
 * 创建 JSON-RPC 方法分发器。
 * @param {{
 *   store: any,
 *   getStats: () => any,
 *   settings: () => any,
 *   saveSettings: (patch: object) => any,
 *   flushNow: () => Promise<number>,
 *   diagnosticsSummary?: () => any,
 * }} deps
 */
export function createRpc(deps) {
  const { store, getStats, settings, saveSettings, flushNow } = deps;

  /** 把内存里的所有行摊平成导出行。 */
  function exportRows(days) {
    const daily = [...store.state.daily.values()].map((row) => ({
      kind: 'daily',
      key: '',
      day: row.day,
      calls: row.toolCalls ?? 0,
      errors: row.toolErrors ?? 0,
      extra: { turns: row.turns ?? 0, sessions: row.sessions ?? 0, tokensIn: row.tokensIn ?? 0, tokensOut: row.tokensOut ?? 0 },
    }));
    const tools = [...store.state.tool_daily.values()].map((row) => ({
      kind: 'tool_daily',
      key: row.tool,
      day: row.day,
      calls: row.calls ?? 0,
      errors: row.errors ?? 0,
      ms: row.ms ?? 0,
      extra: { cap: row.cap },
    }));
    const caps = [...store.state.cap_daily.values()].map((row) => ({
      kind: 'capability_daily',
      key: row.capKey,
      day: row.day,
      calls: row.calls ?? 0,
      errors: row.errors ?? 0,
      extra: { type: row.cap },
    }));
    const cutoff = Date.now() - days * 86400000;
    return [...daily, ...tools, ...caps].filter((row) => {
      const ts = Date.parse(`${row.day}T00:00:00`);
      return Number.isFinite(ts) ? ts >= cutoff - 86400000 : true;
    });
  }

  const methods = {
    /**
     * 4 KPI + 迷你趋势。
     * @param {{ range?: unknown, tzOffset?: number }} params
     */
    overview(params = {}) {
      const days = rangeToDays(params.range, 7);
      return buildOverview(store, { days, topTools: 8 });
    },

    /**
     * 能力/插件榜（本实现以工具名为 `pluginId` 维度，见 docs/design-mapping.md）。
     * @param {{ range?: unknown, q?: string, sort?: string, cursor?: number, state?: string, source?: string }} params
     */
    plugins(params = {}) {
      const days = rangeToDays(params.range, 7);
      const q = str(params.q, 120).toLowerCase();
      const overview = buildOverview(store, { days, topTools: 200 });
      let rows = overview.tools.map((row) => ({
        pluginId: row.tool,
        kind: row.cap,
        calls: row.calls,
        errors: row.errors,
        avgMs: row.avgMs,
        state: 'enabled',
        source: row.cap === 'native' ? 'builtin' : row.cap,
      }));
      if (q !== '') rows = rows.filter((row) => row.pluginId.toLowerCase().includes(q));
      const sort = str(params.sort, 20) || 'calls';
      const key = sort === 'errors' ? (row) => row.errors : sort === 'name' ? (row) => row.pluginId : (row) => row.calls;
      return page(rows, key, { cursor: num(params.cursor, 0), limit: PAGE_SIZE, descending: sort !== 'name' });
    },

    /**
     * 单工具详情。
     * @param {{ pluginId?: string, range?: unknown }} params
     */
    plugin(params = {}) {
      const pluginId = str(params.pluginId, 120);
      if (pluginId === '') throw new ApiError('E_PAYLOAD', 'pluginId 必填');
      const days = rangeToDays(params.range, 14);
      return buildToolDetail(store, { tool: pluginId, days });
    },

    /**
     * 能力排行（type: tool|mcp|skill|all）。
     * @param {{ range?: unknown, type?: string, top?: number }} params
     */
    capabilities(params = {}) {
      const days = rangeToDays(params.range, 7);
      const type = str(params.type, 20) || 'all';
      const top = Math.min(100, Math.max(1, uint(params.top, 20)));
      const overview = buildOverview(store, { days, topTools: 8 });
      const rows = (overview.capabilities ?? [])
        .filter((row) => type === 'all' || row.type === type)
        .slice(0, top);
      return { range: { days }, type, rows };
    },

    /**
     * 版本/环境矩阵。本实现只覆盖自身与宿主 Node（无插件清单数据源）。
     * @param {{ range?: unknown }} params
     */
    env(params = {}) {
      const days = rangeToDays(params.range, 7);
      const stats = getStats() ?? {};
      return {
        range: { days },
        host: { node: process.version, platform: process.platform, arch: process.arch, profile: stats.profileName },
        plugin: { name: stats.plugin, version: stats.version, schema: 1, installId: stats.meta?.installId },
        storage: stats.storage,
        note: '未采集第三方插件清单：本实现只观察会话事件，不枚举宿主 loader。',
      };
    },

    /**
     * 时序（metric: calls|errors|sessions|tokens）。
     * @param {{ range?: unknown, metric?: string, grain?: string }} params
     */
    series(params = {}) {
      const days = rangeToDays(params.range, 14);
      const grain = str(params.grain, 10) || 'day';
      if (grain !== 'day') throw new ApiError('E_RANGE', `暂只支持 grain=day，收到 ${grain}`);
      const metric = str(params.metric, 20) || 'calls';
      // buildSeries 直接返回按天升序的数组，这里只做指标投影。
      const rows = buildSeries(store, { days }).map((row) => ({
        day: row.day,
        value:
          metric === 'errors'
            ? row.toolErrors
            : metric === 'sessions'
              ? row.sessions
              : metric === 'turns'
                ? row.turns
                : row.toolCalls,
      }));
      return { metric, grain, rows };
    },

    /**
     * 原始事件流。本实现的落库粒度是"日聚合 + 会话摘要"，没有逐事件行，
     * 因此这里返回最近会话（含 day/turns/toolCalls/errors），见偏差说明。
     * @param {{ limit?: number, kinds?: string[] }} params
     */
    events(params = {}) {
      const limit = Math.min(MAX_EVENT_LIMIT, Math.max(1, uint(params.limit, 50)));
      const rows = buildRecentSessions(store, limit).map((row) => ({
        kind: 'session',
        id: row.id,
        first: row.first,
        last: row.last,
        turns: row.turns,
        toolCalls: row.toolCalls,
        errors: row.errors,
        model: row.model,
      }));
      return { rows, limit, nextCursor: undefined, degraded: 'aggregated' };
    },

    /** 读设置。 */
    'settings.get'() {
      return settings();
    },

    /**
     * 改设置（部分更新，热生效）。
     * @param {{ patch?: Record<string, unknown> }} params
     */
    'settings.set'(params = {}) {
      const patch = params.patch;
      if (patch === null || typeof patch !== 'object') throw new ApiError('E_PAYLOAD', 'patch 必须是对象');
      const clean = typeof deps.sanitizePatch === 'function' ? deps.sanitizePatch(patch) : patch;
      if (Object.keys(clean).length === 0) throw new ApiError('E_PAYLOAD', '没有可识别的设置项');
      saveSettings(clean);
      return settings();
    },

    /** 同意态：本实现只有 local/off 两态。 */
    'consent.get'() {
      const current = settings();
      return {
        mode: current.collect === false ? 'off' : 'local',
        version: 1,
        fields: [],
        note: '未实现上报通道（telemetry），字段清单为空。',
      };
    },

    /**
     * 切换同意态。只接受 local/off；telemetry 明确报 E_CONSENT。
     * @param {{ mode?: string, version?: number }} params
     */
    'consent.set'(params = {}) {
      const mode = str(params.mode, 20);
      if (mode === 'local' || mode === 'off') {
        saveSettings({ collect: mode === 'local' });
        return { mode, version: uint(params.version, 1), settings: settings() };
      }
      throw new ApiError('E_CONSENT', `不支持的 mode=${mode}：本实现未提供上报通道`, { detail: { mode } });
    },

    /** 上报预览（未启用上报，返回空样本）。 */
    'report.preview'() {
      return { fields: [], sample: null, bytes: 0, saltId: null, enabled: false };
    },

    /** 立即上报（未启用）。 */
    'report.now'() {
      return { queued: 0, bytes: 0, enabled: false };
    },

    /** 清空上报队列（未启用）。 */
    'report.clear'() {
      return { cleared: 0, enabled: false };
    },

    /**
     * 删除本地数据（必须显式 `confirm:'DELETE'`）。
     * @param {{ confirm?: string }} params
     */
    async 'data.delete'(params = {}) {
      if (params.confirm !== 'DELETE') {
        throw new ApiError('E_CONSENT', '必须显式传 confirm:"DELETE"', { detail: { got: params.confirm } });
      }
      const before = store.stats?.writes ?? 0;
      store.reset();
      await flushNow();
      const stats = getStats() ?? {};
      return { freedBytes: 0, clearedRows: stats.storage?.rows ?? null, writesBefore: before };
    },

    /**
     * 导出（json/csv/ndjson，全部在内存内联生成）。
     * @param {{ range?: unknown, format?: string }} params
     */
    export(params = {}) {
      const days = rangeToDays(params.range, 90);
      const format = str(params.format, 10) || 'json';
      if (!['json', 'csv', 'ndjson'].includes(format)) {
        throw new ApiError('E_RANGE', `不支持的 format=${format}`);
      }
      const rows = exportRows(days);
      const payload = serialize(rows, format);
      const name = `dsh-usage-analytics-${new Date().toISOString().slice(0, 10)}.${payload.ext}`;
      return { name, mime: payload.mime, size: Buffer.byteLength(payload.content), content: payload.content, rows: rows.length };
    },

    /** 排障诊断。 */
    diagnostics() {
      return getStats();
    },

    /** 清空并重扫（等效设计里的 F208 重置）。 */
    async reset() {
      store.reset();
      await flushNow();
      return { ok: true };
    },
  };

  /**
   * 调用一个方法。
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<unknown>}
   */
  async function call(method, params) {
    const name = str(method, 60);
    if (name === '') throw new ApiError('E_PAYLOAD', 'method 必填');
    const fn = methods[name];
    if (typeof fn !== 'function') throw new ApiError('E_METHOD', `未知方法 ${name}`, { detail: { methods: Object.keys(methods) } });
    const input = params === null || params === undefined ? {} : params;
    if (typeof input !== 'object') throw new ApiError('E_PAYLOAD', 'params 必须是对象');
    return fn(input);
  }

  return { call, methods, methodNames: Object.keys(methods) };
}
