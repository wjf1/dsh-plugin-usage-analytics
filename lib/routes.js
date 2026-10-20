/**
 * HTTP 路由层：单一 prefix 注册 + 内部精确分派。
 *
 * 为什么不是一个路由注册一个 path：宿主 webServer 的 prefix 重复注册会
 * 直接报 duplicate prefix route 并拖垮整棵插件树（参考件真实事故）；
 * 单 prefix + 内部 switch 也更好做统一围栏与信封。
 *
 * 围栏（评审 P1-5，参考件取证的三层）：
 *  1. Host 层：宿主把服务绑在回环地址，这里再校验 Origin 与 Host 一致；
 *  2. sec-fetch-site：浏览器同源请求为 same-origin，跨站为 cross-site，直接拒；
 *  3. Origin：存在时必须与 Host 完全一致。
 * 注意：这不是安全边界（本机任何进程都能直连回环），只是防"别的网页
 * 通过用户浏览器打到本地端口"的误触发围栏。设计 §14.2-4 的 token/首屏注入
 * 在参考件里没有先例，按评审建议降级为 P2，这里不实现。
 */

import { API_PREFIX, num, str, uint } from './shared.js';
import { buildOverview, buildRecentSessions, buildSeries, buildToolDetail } from './aggregate.js';
import { ApiError, createRpc } from './rpc.js';

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 允许面板修改的设置键与取值范围。 */
const SETTING_RULES = {
  mode: (value) => (['local', 'remote', 'opt-in'].includes(value) ? value : undefined),
  retentionDays: (value) => clampInt(value, 1, 400),
  sampleRate: (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
  },
  collect: (value) => (typeof value === 'boolean' ? value : undefined),
  panelEnabled: (value) => (typeof value === 'boolean' ? value : undefined),
  selfExclude: (value) => (typeof value === 'boolean' ? value : undefined),
};

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * 设置白名单过滤：REST 与 JSON-RPC 两条路径共用，避免绕开范围校验。
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
export function sanitizeSettings(body) {
  const patch = {};
  if (body === null || typeof body !== 'object') return patch;
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!Object.hasOwn(body, key)) continue;
    const value = rule(/** @type {Record<string, unknown>} */ (body)[key]);
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

/**
 * 围栏判定。
 * @param {import('node:http').IncomingMessage} req
 * @returns {'E_ORIGIN' | 'E_METHOD' | null}
 */
export function fence(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return 'E_ORIGIN';
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    const host = str(req.headers.host, 200);
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'E_ORIGIN';
    }
    if (host === '' || originHost !== host) return 'E_ORIGIN';
  }
  return null;
}

/**
 * 读 JSON 请求体，超限直接 reject。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 注意：这里不能 destroy 连接——调用方要回 413，销毁 socket 会让浏览器
        // 收到 RST 而不是错误码。改为丢弃后续数据（drain）后正常回包。
        settled = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { code: 'E_PAYLOAD' }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'E_PAYLOAD' }));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** 统一信封输出。 */
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, value) {
  send(res, 200, { ok: true, value });
}

function fail(res, code, message, status = 200, extra) {
  const error = { code, message };
  if (extra !== null && typeof extra === 'object') {
    if (extra.retryable === true) error.retryable = true;
    if (extra.detail !== undefined) error.detail = extra.detail;
  }
  send(res, status, { ok: false, error });
}

/**
 * 路由表。所有查询都只读内存模型，不做 I/O。
 */
export class Routes {
  /**
   * @param {object} options
   * @param {import('./store.js').AnalyticsStore} options.store
   * @param {() => any} options.getStats 采集器/插件运行态快照
   * @param {Record<string, any>} options.settings 当前生效设置（可写）
   * @param {(patch: Record<string, unknown>) => void} options.saveSettings
   * @param {() => Promise<number>} options.flushNow
   * @param {(msg: string, err?: unknown) => void} options.warn
   */
  constructor({ store, getStats, settings, saveSettings, flushNow, warn, rateLimit = 10 }) {
    this.store = store;
    this.getStats = getStats;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.flushNow = flushNow;
    this.warn = typeof warn === 'function' ? warn : () => {};
    this.handle = this.handle.bind(this);
    /** 每秒允许的 POST 次数（测试可放大以便跑批量用例）。 */
    this.rateLimit = Math.max(1, Math.floor(Number(rateLimit) || 10));
    // JSON-RPC 方法面（设计 §7.5），与上面的 REST 端点共用同一批聚合函数。
    this.rpc = createRpc({
      store,
      getStats,
      settings: () => this.settings,
      saveSettings,
      sanitizePatch: sanitizeSettings,
      flushNow,
    });
    /** @type {number[]} 滑动窗口内的请求时间戳，用于 E_RATE。 */
    this.hits = [];
  }

  /**
   * 简易限速：单客户端 >10 req/s 判 E_RATE（设计 §7.5）。
   * 只对写方法面（POST）生效，GET 读面板不受影响。
   * @returns {boolean} 是否放行
   */
  allowRate() {
    const now = Date.now();
    this.hits = this.hits.filter((at) => now - at < 1000);
    this.hits.push(now);
    return this.hits.length <= this.rateLimit;
  }

  /**
   * 注册到宿主 webServer 用的 handler。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async handle(req, res) {
    const blocked = fence(req);
    if (blocked === 'E_ORIGIN') {
      fail(res, 'E_ORIGIN', '来源不被信任', 403);
      return;
    }
    const method = str(req.method, 10).toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      fail(res, 'E_METHOD', `不支持的请求方法 ${method}`, 405);
      return;
    }
    if (method === 'POST' && !this.allowRate()) {
      fail(res, 'E_RATE', '请求过于频繁（>10 req/s）', 429, { retryable: true });
      return;
    }
    const url = new URL(str(req.url, 2000), 'http://localhost');
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname;
    try {
      await this.dispatch(path, method, url, req, res);
    } catch (error) {
      this.warn(`路由 ${path} 处理失败`, error);
      // 不把内部文本回显给客户端。
      fail(res, 'E_INTERNAL', '内部错误');
    }
  }

  /**
   * JSON-RPC 入口：`POST <prefix>/`，body `{ method, params }`。
   * 错误一律回 `{ ok:false, error:{ code, message, retryable?, detail? } }`，
   * HTTP 状态取设计 §7.5 的错误码表（业务错误默认 200，围栏/限速/载荷用真实状态）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async handleRpc(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      const tooLarge = error?.code === 'E_PAYLOAD';
      fail(res, 'E_PAYLOAD', tooLarge ? '请求体超过 64KB 上限' : '请求体不是合法 JSON', 413);
      return;
    }
    const method = str(body?.method, 60);
    if (method === '') {
      fail(res, 'E_PAYLOAD', '缺少 method 字段', 413, { detail: { methods: this.rpc.methodNames } });
      return;
    }
    try {
      const value = await this.rpc.call(method, body?.params);
      ok(res, value);
    } catch (error) {
      if (error instanceof ApiError) {
        fail(res, error.code, error.message, error.status, { retryable: error.retryable, detail: error.detail });
        return;
      }
      this.warn(`RPC 方法 ${method} 失败`, error);
      fail(res, 'E_INTERNAL', '内部错误');
    }
  }

  /**
   * 精确分派。
   * @param {string} path 去掉 prefix 后的路径
   */
  async dispatch(path, method, url, req, res) {
    const q = url.searchParams;
    if (method === 'POST' && (path === '/' || path === '/rpc')) {
      await this.handleRpc(req, res);
      return;
    }
    if (method === 'GET' && (path === '/' || path === '/health')) {
      ok(res, { ready: true, plugin: 'dsh-plugin-usage-analytics', time: Date.now() });
      return;
    }
    if (method === 'GET' && path === '/overview') {
      ok(res, buildOverview(this.store, { days: num(q.get('days'), 7), topTools: num(q.get('top'), 8) }));
      return;
    }
    if (method === 'GET' && path === '/series') {
      ok(res, buildSeries(this.store, { days: num(q.get('days'), 14) }));
      return;
    }
    if (method === 'GET' && path === '/sessions') {
      ok(res, buildRecentSessions(this.store, num(q.get('limit'), 20)));
      return;
    }
    if (method === 'GET' && path === '/tool') {
      const name = str(q.get('name'), 120);
      if (name === '') {
        fail(res, 'E_RANGE', '缺少 name');
        return;
      }
      ok(res, buildToolDetail(this.store, { tool: name, days: num(q.get('days'), 14) }));
      return;
    }
    if (method === 'GET' && path === '/tools') {
      const overview = buildOverview(this.store, { days: num(q.get('days'), 7), topTools: num(q.get('top'), 30) });
      ok(res, overview.tools);
      return;
    }
    if (method === 'GET' && path === '/settings') {
      ok(res, this.settings);
      return;
    }
    if (method === 'POST' && path === '/settings') {
      const body = await readJsonBody(req);
      const patch = sanitizeSettings(body);
      if (Object.keys(patch).length === 0) {
        fail(res, 'E_PAYLOAD', '没有可识别的设置项');
        return;
      }
      this.saveSettings(patch);
      ok(res, this.settings);
      return;
    }
    if (method === 'GET' && path === '/diagnostics') {
      ok(res, this.getStats());
      return;
    }
    if (method === 'POST' && path === '/flush') {
      const written = await this.flushNow();
      ok(res, { written });
      return;
    }
    if (method === 'POST' && path === '/reset') {
      this.store.reset();
      await this.flushNow();
      ok(res, { reset: true });
      return;
    }
    if (method === 'GET' && path === '/export') {
      const rows = [];
      for (const row of this.store.state.daily.values()) rows.push({ kind: 'daily', ...row });
      for (const row of this.store.state.tool_daily.values()) rows.push({ kind: 'tool_daily', ...row });
      for (const row of this.store.state.cap_daily.values()) rows.push({ kind: 'capability_daily', ...row });
      const body = rows.map((row) => JSON.stringify(row)).join('\n');
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="dsh-usage-analytics-${new Date().toISOString().slice(0, 10)}.ndjson"`,
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    fail(res, 'E_RANGE', `未知接口 ${path}`, 404);
  }
}

/** 供测试直接构造一个最小 req 对象。 */
export function fakeRequest({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers };
}

/** 端点清单，客户端与文档共用。 */
export const ENDPOINTS = Object.freeze([
  ['POST', '/', 'JSON-RPC 方法面（设计 §7.5）'],
  ['GET', '/overview', '概览 KPI、窗口汇总、Top 工具'],
  ['GET', '/series', '逐日趋势'],
  ['GET', '/tools', '工具排行'],
  ['GET', '/tool', '单工具逐日明细'],
  ['GET', '/sessions', '最近会话'],
  ['GET', '/settings', '读取设置'],
  ['POST', '/settings', '更新设置'],
  ['GET', '/diagnostics', '运行态诊断'],
  ['GET', '/export', '导出 NDJSON'],
  ['POST', '/flush', '立即落盘'],
  ['POST', '/reset', '清空本地数据'],
]);
