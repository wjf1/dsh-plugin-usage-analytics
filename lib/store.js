/**
 * 存储层：内存模型 + 脏行合并落盘。
 *
 * 为什么是"内存模型 + 定时 flush"：
 *  - 宿主存储只提供 get/entries/keys/put/delete/update，没有 batch/replace
 *    （评审 P0-2 已核实），逐条写会把 I/O 摊进采集热路径；
 *  - 设计 §6.3 硬约束要求采集回调禁止 I/O；
 *  - 因此采集只改内存并标脏，flush 周期（默认 10s）只写脏行，脏表为空时完全跳过。
 *
 * domain 生命周期（参考件真实事故）：
 *  - `storageDomain.open()` 同名每进程只能开一次，第二次抛 already-open；
 *    旧 fiber 没 close 会直接把宿主拖成 FATAL。所以 domain 必须挂
 *    `globalThis` 单例，跨 HMR 复用，退出时 close 且 close 幂等。
 */

import { DOMAIN_PREFIX, MAX_DAILY_ROWS, MAX_SESSION_ROWS, MAX_FLUSH_ROWS, num, safeGet, str, uint } from './shared.js';

/** 跨 HMR 的 domain 单例表：name -> { domain, closed }。 */
const REGISTRY_KEY = Symbol.for('dsh-plugin-usage-analytics/domains');

/** @returns {Map<string, {domain: any, closed: boolean}>} */
function registry() {
  if (globalThis[REGISTRY_KEY] === undefined) globalThis[REGISTRY_KEY] = new Map();
  return globalThis[REGISTRY_KEY];
}

// ── 值 schema：只做归一化，绝不抛错 ───────────────────────────────────────────
// 宿主在加载记录时会调用 `valueSchema.parse(raw)`；这里抛错会让整条记录
// 被判定为 invalid-record。所以全部"坏值回默认"。

/** @param {any} value @returns {boolean} */
const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 单表 schema 工厂。 */
const schema = (normalize) => ({ parse: (value) => normalize(isObj(value) ? value : {}) });

/** meta 表：插件安装标识、游标、设置。 */
const metaSchema = schema((raw) => ({
  v: 1,
  installId: str(raw.installId, 64) || '',
  createdAt: uint(raw.createdAt, 0),
  updatedAt: uint(raw.updatedAt, 0),
  /** 已回填/已订阅到的会话游标：sessionId -> 最后消费的 seq。 */
  cursors: isObj(raw.cursors) ? Object.fromEntries(
    Object.entries(raw.cursors)
      .map(([key, value]) => [str(key, 80), uint(value, 0)])
      .filter(([key]) => key !== '')
      .slice(-400),
  ) : {},
  /** 面板里改的运行时设置（与 cordis config 合并，面板优先）。 */
  settings: isObj(raw.settings) ? raw.settings : {},
  /** 采样/丢弃计数，用于诊断。 */
  dropped: uint(raw.dropped, 0),
  sampled: uint(raw.sampled, 0),
}));

/** 日总表。 */
const dailySchema = schema((raw) => ({
  day: str(raw.day, 10),
  events: uint(raw.events, 0),
  toolCalls: uint(raw.toolCalls, 0),
  toolErrors: uint(raw.toolErrors, 0),
  steps: uint(raw.steps, 0),
  turns: uint(raw.turns, 0),
  sessions: uint(raw.sessions, 0),
  tokensIn: uint(raw.tokensIn, 0),
  tokensOut: uint(raw.tokensOut, 0),
  ms: uint(raw.ms, 0),
  msSamples: uint(raw.msSamples, 0),
  maxMs: uint(raw.maxMs, 0),
  panels: uint(raw.panels, 0),
  commands: uint(raw.commands, 0),
  mcp: uint(raw.mcp, 0),
  skills: uint(raw.skills, 0),
  dropped: uint(raw.dropped, 0),
}));

/** 工具日表。 */
const toolDailySchema = schema((raw) => ({
  day: str(raw.day, 10),
  tool: str(raw.tool, 120),
  cap: str(raw.cap, 16) || 'native',
  calls: uint(raw.calls, 0),
  errors: uint(raw.errors, 0),
  ms: uint(raw.ms, 0),
  samples: uint(raw.samples, 0),
  maxMs: uint(raw.maxMs, 0),
  lastAt: uint(raw.lastAt, 0),
}));

/** 能力日表（mcp / skill 维度）。 */
const capDailySchema = schema((raw) => ({
  day: str(raw.day, 10),
  type: str(raw.type, 16) || 'mcp',
  key: str(raw.key, 160),
  calls: uint(raw.calls, 0),
  errors: uint(raw.errors, 0),
  lastAt: uint(raw.lastAt, 0),
}));

/** 会话表：只放标识与计数，不存标题、不存 cwd（隐私最小化）。 */
const sessionSchema = schema((raw) => ({
  id: str(raw.id, 40),
  first: uint(raw.first, 0),
  last: uint(raw.last, 0),
  turns: uint(raw.turns, 0),
  toolCalls: uint(raw.toolCalls, 0),
  errors: uint(raw.errors, 0),
  model: str(raw.model, 80),
}));

/** 表定义：键 → schema。设计 §5.2 的精简落地（去掉上报相关表）。 */
export const TABLES = Object.freeze({
  meta: metaSchema,
  daily: dailySchema,
  tool_daily: toolDailySchema,
  cap_daily: capDailySchema,
  sessions: sessionSchema,
});

/** 主键字符集必须落在 `[a-zA-Z0-9_-]+`（per-record 布局的硬要求）。 */
export function keyPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || '_';
}

/** 复合键：用 `__` 连接，避免与单键冲突。 */
export function compositeKey(...parts) {
  return parts.map(keyPart).join('__');
}

/**
 * 内存模型 + 落盘。构造后调用 load() 才能查询。
 */
export class AnalyticsStore {
  /**
   * @param {object} options
   * @param {string} options.domainName 真实 domain 名（含 profile 后缀）
   * @param {any} options.domain 已打开的 storage domain
   * @param {(msg: string, err?: unknown) => void} [options.warn] 日志钩子
   */
  constructor({ domainName, domain, warn }) {
    this.domainName = domainName;
    this.domain = domain;
    this.warn = typeof warn === 'function' ? warn : () => {};
    /** @type {Map<string, any>} */
    this.tables = new Map();
    /** @type {Map<string, Set<string>>} tableName -> dirty keys */
    this.dirty = new Map();
    this.metaDirty = false;
    this.closed = false;
    this.stats = { writes: 0, flushCount: 0, lastFlushAt: 0 };
    /** 内存模型，查询侧只读。 */
    this.state = {
      /** @type {any} */
      meta: metaSchema.parse({}),
      /** @type {Map<string, any>} */
      daily: new Map(),
      /** @type {Map<string, any>} */
      tool_daily: new Map(),
      /** @type {Map<string, any>} */
      cap_daily: new Map(),
      /** @type {Map<string, any>} */
      sessions: new Map(),
    };
  }

  /** 从 domain 读出全部行，建立内存模型。读同步、只读一次。 */
  load() {
    for (const [name, valueSchema] of Object.entries(TABLES)) {
      let table;
      try {
        table = this.domain.table(name);
      } catch (error) {
        this.warn(`表 ${name} 不可用`, error);
        continue;
      }
      this.tables.set(name, table);
      if (name === 'meta') continue;
      const target = this.state[name];
      try {
        for (const [key, value] of table.entries()) {
          target.set(String(key), valueSchema.parse(value));
        }
      } catch (error) {
        this.warn(`表 ${name} 读取失败`, error);
      }
    }
    try {
      this.state.meta = metaSchema.parse(this.domain.global.get());
    } catch (error) {
      this.warn('meta 读取失败', error);
    }
    return this;
  }

  /** 当前 meta（只读引用，改动请走 patchMeta）。 */
  get meta() {
    return this.state.meta;
  }

  /**
   * 合并更新 meta 并标脏。
   * @param {Record<string, unknown>} patch
   */
  patchMeta(patch) {
    this.state.meta = metaSchema.parse({ ...this.state.meta, ...patch, updatedAt: Date.now() });
    this.metaDirty = true;
  }

  /** 读某张表的某一行。 */
  row(table, key) {
    const map = this.state[table];
    return map instanceof Map ? map.get(key) : undefined;
  }

  /**
   * 写某张表的一行（内存 + 标脏）。
   * @param {'daily'|'tool_daily'|'cap_daily'|'sessions'} table
   * @param {string} key
   * @param {any} value
   */
  put(table, key, value) {
    const map = this.state[table];
    if (!(map instanceof Map)) return;
    const valueSchema = TABLES[table];
    map.set(key, valueSchema.parse(value));
    let keys = this.dirty.get(table);
    if (keys === undefined) {
      keys = new Set();
      this.dirty.set(table, keys);
    }
    keys.add(key);
  }

  /** 删一行（内存 + 标脏）。 */
  remove(table, key) {
    const map = this.state[table];
    if (!(map instanceof Map)) return;
    if (map.delete(key)) {
      let keys = this.dirty.get(table);
      if (keys === undefined) {
        keys = new Set();
        this.dirty.set(table, keys);
      }
      keys.add(key);
    }
  }

  /** 是否有待写数据。 */
  get isDirty() {
    if (this.metaDirty) return true;
    for (const keys of this.dirty.values()) if (keys.size > 0) return true;
    return false;
  }

  /** 待写行数（跨表）。 */
  get dirtyCount() {
    let total = 0;
    for (const keys of this.dirty.values()) total += keys.size;
    return total;
  }

  /**
   * 把内存里标脏的行写回 domain。
   * 写序：先游标/元数据，再数据行 —— 反过来在崩溃时会重复计数。
   * 单次最多写 MAX_FLUSH_ROWS 行，剩余留给下一周期。
   * @returns {Promise<number>} 实际写入行数
   */
  async flush() {
    if (this.closed || !this.isDirty) return 0;
    let written = 0;
    if (this.metaDirty) {
      try {
        // global.set() 返回 Promise：不 await 的话失败会逃成 unhandledRejection，
        // 宿主按 fatal load failure 直接退进程（同 open 未 await 那次事故）。
        await this.domain.global.set(this.state.meta);
        written += 1;
        this.metaDirty = false;
      } catch (error) {
        this.warn('meta 写入失败', error);
      }
    }
    for (const [tableName, keys] of this.dirty) {
      const table = this.tables.get(tableName);
      if (table === undefined) continue;
      for (const key of keys) {
        if (written >= MAX_FLUSH_ROWS) return written;
        const value = this.state[tableName]?.get(key);
        try {
          if (value === undefined) await table.delete(key);
          else await table.put(key, value);
          keys.delete(key);
          written += 1;
        } catch (error) {
          this.warn(`写入 ${tableName}/${key} 失败`, error);
          break; // 存储层异常时停止本轮，避免无谓刷屏
        }
      }
    }
    this.stats.writes += written;
    this.stats.flushCount += 1;
    this.stats.lastFlushAt = Date.now();
    return written;
  }

  /**
   * 裁剪：日表按 retentionDays、会话表按条数上限。
   * 只在 flush 之后调用，删除会再次标脏。
   * @param {number} retentionDays
   * @param {number} [now]
   */
  prune(retentionDays, now = Date.now()) {
    const cutoff = new Date(now);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - Math.max(1, Math.floor(retentionDays)));
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;

    let removed = 0;
    const pruneByDay = (tableName) => {
      const map = this.state[tableName];
      if (!(map instanceof Map)) return;
      const stale = [];
      for (const [key, value] of map) {
        if (str(value?.day, 10) !== '' && value.day < cutoffKey) stale.push(key);
      }
      for (const key of stale) {
        this.remove(tableName, key);
        removed += 1;
      }
      // 行数兜底：仍超上限就从最旧的日期开始删。
      if (map.size > MAX_DAILY_ROWS) {
        const keys = [...map.keys()].sort((a, b) => {
          const da = str(map.get(a)?.day, 10);
          const db = str(map.get(b)?.day, 10);
          return da < db ? -1 : da > db ? 1 : 0;
        });
        for (const key of keys.slice(0, map.size - MAX_DAILY_ROWS)) {
          this.remove(tableName, key);
          removed += 1;
        }
      }
    };
    pruneByDay('daily');
    pruneByDay('tool_daily');
    pruneByDay('cap_daily');

    if (this.state.sessions.size > MAX_SESSION_ROWS) {
      const ordered = [...this.state.sessions.entries()]
        .sort((a, b) => num(a[1]?.last) - num(b[1]?.last));
      for (const [key] of ordered.slice(0, this.state.sessions.size - MAX_SESSION_ROWS)) {
        this.remove('sessions', key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 清空全部行（数据删除权）。 */
  reset() {
    for (const tableName of ['daily', 'tool_daily', 'cap_daily', 'sessions']) {
      const map = this.state[tableName];
      if (!(map instanceof Map)) continue;
      for (const key of [...map.keys()]) this.remove(tableName, key);
    }
    const keep = { installId: this.state.meta.installId, createdAt: this.state.meta.createdAt };
    this.state.meta = metaSchema.parse({ ...keep, updatedAt: Date.now() });
    this.metaDirty = true;
  }

  /** 关闭：先尽力 flush，再 close domain（幂等）。 */
  async close() {
    if (this.closed) return;
    try {
      await this.flush();
    } catch (error) {
      this.warn('关闭前 flush 失败', error);
    }
    this.closed = true;
    try {
      // close() 同样返回 Promise，必须 await（失败也要落到 warn，不能逃成 unhandledRejection）。
      await this.domain.close?.();
    } catch (error) {
      this.warn('domain.close 失败', error);
    }
  }
}

/**
 * 打开（或复用）本插件的 storage domain。
 *
 * @param {any} ctx cordis 上下文（需已注入 storageDomain）
 * @param {object} options
 * @param {string} options.profileName profile 名（拼进 domain 名，隔离多 profile）
 * @param {'single'|'per-record'} options.layout
 * @param {(msg: string, err?: unknown) => void} [options.warn]
 * @returns {Promise<AnalyticsStore>}
 */
export async function openStore(ctx, { profileName, layout, warn }) {
  const domainName = `${DOMAIN_PREFIX}${keyPart(profileName || 'default')}`;
  const cache = registry();
  const existing = cache.get(domainName);
  if (existing !== undefined && existing.closed !== true) {
    // HMR 复用：同一个 domain 对象再包一层 store 是安全的（读同步自内存）。
    // entry.promise 让并发的两次 apply 共享同一次 open（否则会撞 already-open）。
    const domain = await existing.promise;
    const store = new AnalyticsStore({ domainName, domain, warn });
    return store.load();
  }
  const spec = {
    name: domainName,
    version: 1,
    layout: layout === 'per-record' ? 'per-record' : 'single',
    tables: Object.fromEntries(Object.entries(TABLES).map(([key, value]) => [key, { valueSchema: value }])),
    global: { schema: metaSchema, initial: metaSchema.parse({}) },
  };
  const service = safeGet(ctx, 'storageDomain') ?? (typeof ctx.get === 'function' ? ctx.get('storageDomain') : undefined);
  if (service === undefined || typeof service.open !== 'function') throw new Error('storageDomain 服务不可用');
  // DomainFacility.open() 是 async：必须在 cache 里先占位 promise 再 await，
  // 既让调用方 catch 到描述符校验失败（降级内存档），又不产生无人处理的 rejection。
  const entry = { promise: service.open(spec), closed: false };
  cache.set(domainName, entry);
  let domain;
  try {
    domain = await entry.promise;
  } catch (error) {
    // 打开失败不能留下毒缓存：下一次 apply（或重启后的重试）必须能重新 open。
    entry.closed = true;
    if (cache.get(domainName) === entry) cache.delete(domainName);
    throw error;
  }
  const store = new AnalyticsStore({ domainName, domain, warn });
  store.load();
  // 首次运行生成安装标识；它不是指纹，只用于本地设备内区分。
  if (store.meta.installId === '') {
    store.patchMeta({ installId: `ins_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, createdAt: Date.now() });
  }
  return store;
}

/**
 * 关掉某个 domain 并把它从单例表移除。
 * @param {string} domainName
 */
export function forgetDomain(domainName) {
  const cache = registry();
  const entry = cache.get(domainName);
  if (entry === undefined) return;
  entry.closed = true;
  cache.delete(domainName);
}

/**
 * 内存版 domain：宿主没有 storageDomain 服务时的降级实现。
 * 行为与真实 domain 的读接口一致（get/entries/keys/size/put/delete/update），
 * 但没有持久化 —— 进程退出即丢，诊断里明确标 storage=memory。
 * @param {object} spec 与真实 domain 相同的 spec
 * @returns {any}
 */
export function memoryDomain(spec) {
  const tables = new Map();
  for (const name of Object.keys(spec.tables ?? {})) tables.set(name, new Map());
  let globalValue = spec.global?.initial ?? {};
  const tableOf = (name) => {
    let map = tables.get(name);
    if (map === undefined) {
      map = new Map();
      tables.set(name, map);
    }
    return map;
  };
  return {
    table(name) {
      const map = tableOf(name);
      return {
        get: (key) => map.get(key),
        entries: () => map.entries(),
        keys: () => map.keys(),
        get size() {
          return map.size;
        },
        put: (key, value) => {
          map.set(key, value);
        },
        delete: (key) => {
          map.delete(key);
        },
        update: (key, updater) => {
          const current = map.get(key);
          if (current === undefined) throw Object.assign(new Error(`no record ${key} to update`), { code: 'missing-key' });
          map.set(key, updater(current));
        },
      };
    },
    global: {
      get: () => globalValue,
      set: (value) => {
        globalValue = value;
      },
    },
    close: () => {},
  };
}

/**
 * 内存 store（降级档）。接口与 openStore 返回的完全一致。
 * @param {(msg: string, err?: unknown) => void} [warn]
 * @returns {AnalyticsStore}
 */
export function createMemoryStore(warn) {
  const domainName = `${DOMAIN_PREFIX}memory`;
  const spec = {
    name: domainName,
    version: 1,
    tables: Object.fromEntries(Object.entries(TABLES).map(([key, value]) => [key, { valueSchema: value }])),
    global: { schema: metaSchema, initial: metaSchema.parse({}) },
  };
  const store = new AnalyticsStore({ domainName, domain: memoryDomain(spec), warn });
  store.load();
  store.patchMeta({ installId: `mem_${Math.random().toString(36).slice(2, 10)}`, createdAt: Date.now() });
  return store;
}
