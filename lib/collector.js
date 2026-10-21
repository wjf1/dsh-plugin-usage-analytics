/**
 * 采集层：订阅会话事件流，把事件折叠成聚合事实。
 *
 * 硬约束（设计 §6.3，参考件事故复盘）：
 *  1. 回调里禁止任何 I/O —— 只改内存 + 标脏，落盘交给 flush 周期；
 *  2. 回调绝不抛出 —— cordis 的 emit 是 stop-on-throw，抛一次会让排在
 *     后面的所有订阅者（包括别的插件）都收不到事件；
 *  3. 幂等 —— 同一个 seq 只能消费一次；重启后靠持久游标（meta.cursors）
 *     继续，fork 出来的子会话靠 inheritedEventCount 跳过父前缀。
 */

import { MAX_PENDING_CALLS, PLUGIN_NAME, classifyTool, dayKey, num, safeGet, shortHash, str, uint } from './shared.js';
import { bumpDay, noteSessionFirstSeen, noteSessionStats, noteToolCall, noteToolResult, dayRow } from './aggregate.js';

/** 订阅的事件类型白名单：只处理这几种，其余直接跳过（热路径要短）。 */
const WATCHED = new Set([
  'tool/call',
  'tool/result',
  'turn/start',
  'step/start',
  'assistant/message',
  'command/run',
  'session/created',
  'session/title',
  'request/context',
  'model/selection',
]);

/**
 * 会话事件采集器。
 */
export class Collector {
  /**
   * @param {object} options
   * @param {any} options.ctx cordis 上下文
   * @param {import('./store.js').AnalyticsStore} options.store
   * @param {ReturnType<import('./shared.js').resolveConfig>} options.config
   * @param {(msg: string, err?: unknown) => void} [options.warn]
   */
  constructor({ ctx, store, config, warn }) {
    this.ctx = ctx;
    this.store = store;
    this.config = config;
    this.warn = typeof warn === 'function' ? warn : () => {};
    /** 已接管的会话（哈希 id）。 */
    this.adopted = new Set();
    /** callId -> 待配对调用。 */
    this.pending = new Map();
    /**
     * 被抽稀掉的 tool/call 的 callId -> 占位（只有 key 有用）。
     *
     * 采样必须成对：call 被抽掉时若 result 照常计入，就会出现"只有结果、
     * 没有调用"的孤儿，工具耗时与错误率口径都会偏。这里记住被抽掉的
     * callId，配对的结果一起丢。
     */
    this.droppedCalls = new Map();
    /** 每个会话的实时计数，减少行写入频率。 */
    this.turnSeen = new Set();
    this.disposers = [];
    this.stats = {
      adopted: 0,
      backfilled: 0,
      events: 0,
      toolCalls: 0,
      toolResults: 0,
      sampled: 0,
      selfExcluded: 0,
      dropped: 0,
      errors: 0,
      lastEventAt: 0,
    };
  }

  /** 会话哈希 id：原始 id 不落盘（隐私最小化）。 */
  sidOf(session) {
    const raw = typeof session?.id === 'string' ? session.id : String(session?.id ?? '');
    return shortHash(`${raw}:${this.store.meta.installId || 'noinstall'}`);
  }

  /**
   * 注册监听并回填已存在的会话。
   * @param {{ onFlush?: () => void }} [hooks]
   * @returns {() => void} disposer
   */
  attach(hooks = {}) {
    const ctx = this.ctx;
    const on = (name, handler) => {
      const dispose = ctx.on(name, handler);
      if (typeof dispose === 'function') this.disposers.push(dispose);
    };
    on('session/created', (session) => this.guard(() => this.adopt(session)));
    on('session/event', (session, event) => this.guard(() => {
      this.adopt(session, { quiet: true });
      this.consume(session, event);
    }, event));
    on('session/disposed', (session) => this.guard(() => {
      const sid = this.sidOf(session);
      this.adopted.delete(sid);
      for (const [callId, call] of this.pending) if (call.sid === sid) this.pending.delete(callId);
      // 会话结束时清掉被抽掉的 callId 占位，避免跨会话串味。
      this.droppedCalls.clear();
    }));
    on('session/flush', () => {
      try {
        hooks.onFlush?.();
      } catch (error) {
        this.warn('flush 钩子失败', error);
      }
    });
    // 热重载不会重放 session/created，必须主动扫一遍已存在的会话。
    this.sweep();
    return () => {
      for (const dispose of this.disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 忽略卸载期异常 */
        }
      }
      this.pending.clear();
      this.adopted.clear();
    };
  }

  /** 保护性包裹：任何异常都只能记日志，不能逃逸到 cordis emit。 */
  guard(step, event) {
    try {
      step();
    } catch (error) {
      this.stats.errors += 1;
      this.warn(`采集回调失败${event?.type ? `（${event.type}）` : ''}`, error);
    }
  }

  /** 接管当前所有活着的会话。 */
  sweep() {
    // sessions 也是服务：cordis 上直接读未 inject 的服务会抛错，必须 safeGet。
    const sessions = safeGet(this.ctx, 'sessions');
    const list = typeof sessions?.list === 'function' ? sessions.list() : [];
    for (const session of list) this.guard(() => this.adopt(session));
    return list.length;
  }

  /**
   * 接管一个会话：建行、按游标回填。
   * @param {any} session
   * @param {{ quiet?: boolean }} [options]
   */
  adopt(session, options = {}) {
    const sid = this.sidOf(session);
    if (this.adopted.has(sid)) return;
    this.adopted.add(sid);
    this.stats.adopted += 1;

    const now = Date.now();
    const model = str(session?.header?.model, 80);
    noteSessionFirstSeen(this.store, { id: sid, day: dayKey(now), ts: now, model });

    // 回填：从持久游标之后开始；fork 子会话从继承前缀之后开始。
    const cursor = uint(this.store.meta.cursors?.[sid], Number.NaN);
    let from = 0;
    if (Number.isFinite(cursor)) from = cursor + 1;
    else if (session?.header?.isSeeded === true && uint(session.inheritedEventCount) > 0) {
      from = uint(session.inheritedEventCount);
    }
    if (from >= 0 && typeof session?.snapshotEvents === 'function') {
      const events = session.snapshotEvents(from);
      for (const event of events) {
        this.consume(session, event, { replay: true });
        this.stats.backfilled += 1;
      }
    }
    if (options.quiet !== true) this.touchMeta();
  }

  /** 写入游标（走 markDirty，避免每事件重建整个 meta 对象）。 */
  touchMeta(cursor) {
    if (cursor !== undefined) {
      const meta = this.store.state.meta;
      meta.cursors = { ...meta.cursors, [cursor.sid]: cursor.seq };
      // 会话多了只保留最近的 400 条，防止 meta 无限增长。
      const keys = Object.keys(meta.cursors);
      if (keys.length > 400) {
        for (const key of keys.slice(0, keys.length - 400)) delete meta.cursors[key];
      }
    }
    this.store.metaDirty = true;
  }

  /**
   * 这条事件是否由本插件自己产生（`selfExclude` 开关的判定依据）。
   *
   * 宿主事件里没有统一的"是哪个插件发的"字段，因此按可判定的标记来认：
   *  1. 事件或载荷上的归属字段（`source`/`plugin`/`origin`）等于本插件包名；
   *  2. 工具名落在本插件的 MCP 命名空间（`mcp__<包名>__…`）或就是包名。
   *
   * 注意 `data.source` 在工具维度里还表示 `builtin`/`mcp`/`skill`，
   * 所以这里只做全等比较，不会把普通工具调用误判成本插件自己。
   *
   * @param {any} event
   * @returns {boolean}
   */
  isOwnEvent(event) {
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    for (const candidate of [event.source, event.plugin, event.origin, data.source, data.plugin, data.origin]) {
      if (typeof candidate === 'string' && candidate === PLUGIN_NAME) return true;
    }
    const tool = str(data.name, 200);
    if (tool === PLUGIN_NAME) return true;
    if (tool.startsWith(`mcp__${PLUGIN_NAME}`)) return true;
    return false;
  }

  /**
   * 消费一条会话事件。
   * @param {any} session
   * @param {any} event
   * @param {{ replay?: boolean }} [options]
   */
  consume(session, event, options = {}) {
    if (event === null || typeof event !== 'object') return;
    const type = str(event.type, 64);
    if (!WATCHED.has(type)) return;
    const sid = this.sidOf(session);
    const seq = uint(event.seq, 0);
    const previous = uint(this.store.meta.cursors?.[sid], Number.NaN);
    if (Number.isFinite(previous) && seq <= previous) return; // 幂等：同一 seq 只算一次

    // 隐私开关：排除本插件自身产生的调用（README/config 承诺的 selfExclude）。
    // 游标照常推进，否则下一轮回填还会再判一次同一事件。
    if (this.config.selfExclude === true && this.isOwnEvent(event)) {
      this.stats.selfExcluded += 1;
      this.touchMeta({ sid, seq });
      return;
    }

    // 采样：成对抽稀，只抽稀不做加权外推（面板会显式标注采样率，避免假精确）。
    // 请求与响应必须同进同出，否则耗时/错误率会被孤儿 result 拉偏。
    const rate = num(this.config.sampleRate, 1);
    if (rate < 1 && (type === 'tool/call' || type === 'tool/result')) {
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
      const callId = type === 'tool/call'
        ? str(data.callId, 80)
        : (str(data.message?.toolCallId, 80) || str(data.message?.source?.callId, 80));

      let drop;
      if (type === 'tool/result' && callId !== '') {
        if (this.droppedCalls.delete(callId)) {
          // 配对的 call 已经被抽掉，result 跟着丢。
          drop = true;
        } else if (this.pending.has(callId)) {
          // 配对的 call 已保留，result 必须保留——再掷一次骰子就会出现
          // "有调用没结果"的缺口，耗时/成功率照样失真。
          drop = false;
        } else {
          // 找不到配对（历史结果、别的会话），只能独立判定。
          drop = Math.random() > rate;
        }
      } else {
        drop = Math.random() > rate;
        if (drop && type === 'tool/call' && callId !== '') {
          this.droppedCalls.set(callId, 0);
          if (this.droppedCalls.size > MAX_PENDING_CALLS) {
            const oldest = this.droppedCalls.keys().next();
            if (oldest.done !== true) this.droppedCalls.delete(oldest.value);
          }
        }
      }

      if (drop) {
        this.stats.sampled += 1;
        this.store.state.meta.sampled = uint(this.store.state.meta.sampled) + 1;
        this.touchMeta({ sid, seq });
        return;
      }
    }

    const ts = uint(event.time, Date.now()) || Date.now();
    const day = dayKey(ts);
    this.stats.events += 1;
    this.stats.lastEventAt = ts;

    // 单日事件上限：超了就只记 dropped。
    const row = dayRow(this.store, day);
    if (uint(row.events, 0) >= this.config.maxEventsPerDay) {
      this.stats.dropped += 1;
      this.store.state.meta.dropped = uint(this.store.state.meta.dropped) + 1;
      bumpDay(this.store, day, { dropped: 1 });
      this.touchMeta({ sid, seq });
      return;
    }
    bumpDay(this.store, day, { events: 1 });

    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};

    switch (type) {
      case 'tool/call': {
        const name = str(data.name, 120);
        const classified = classifyTool(name, data.arguments);
        noteToolCall(this.store, { day, tool: classified.tool, cap: classified.cap, capKey: classified.capKey, ts });
        this.stats.toolCalls += 1;
        noteSessionStats(this.store, { id: sid, toolCalls: 1, ts });
        const callId = str(data.callId, 80);
        if (callId !== '') {
          this.pending.set(callId, { sid, day, ts, tool: classified.tool });
          if (this.pending.size > MAX_PENDING_CALLS) {
            const oldest = this.pending.keys().next();
            if (oldest.done !== true) this.pending.delete(oldest.value);
          }
        }
        break;
      }
      case 'tool/result': {
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {};
        const callId = str(message.toolCallId, 80) || str(message.source?.callId, 80);
        const call = callId !== '' ? this.pending.get(callId) : undefined;
        if (callId !== '') this.pending.delete(callId);
        const ok = message.isError !== true;
        const tool = call?.tool || str(data.name, 120) || 'unknown';
        const ms = call === undefined ? null : Math.max(0, ts - call.ts);
        noteToolResult(this.store, { day, tool, ok, ms, ts });
        if (ok === false) noteSessionStats(this.store, { id: sid, errors: 1, ts });
        this.stats.toolResults += 1;
        break;
      }
      case 'turn/start': {
        bumpDay(this.store, day, { turns: 1 });
        noteSessionStats(this.store, { id: sid, turns: 1, ts });
        break;
      }
      case 'step/start': {
        bumpDay(this.store, day, { steps: 1 });
        break;
      }
      case 'command/run': {
        bumpDay(this.store, day, { commands: 1 });
        break;
      }
      case 'assistant/message': {
        const usage = data.usage;
        if (usage !== null && typeof usage === 'object') {
          const tokensIn = pickNumber(usage, ['input_tokens', 'promptTokens', 'inputTokens', 'prompt_tokens']);
          const tokensOut = pickNumber(usage, ['output_tokens', 'completionTokens', 'outputTokens', 'completion_tokens']);
          if (tokensIn > 0 || tokensOut > 0) bumpDay(this.store, day, { tokensIn, tokensOut });
        }
        break;
      }
      case 'request/context':
      case 'model/selection': {
        const model = str(data.model, 80);
        if (model !== '') noteSessionStats(this.store, { id: sid, model, ts });
        break;
      }
      default:
        break;
    }

    this.touchMeta({ sid, seq });
    if (options.replay !== true) this.stats.adopted = this.adopted.size;
  }

  /** 待配对调用数（诊断用）。 */
  get pendingCount() {
    return this.pending.size;
  }
}

/** 从 usage 对象里挑第一个数字字段。 */
function pickNumber(source, keys) {
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}
