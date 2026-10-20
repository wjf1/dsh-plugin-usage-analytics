/**
 * 测试脚手架：一个最小可用的 cordis 上下文替身 + 假会话。
 *
 * 目标不是复刻宿主，而是把插件用到的契约面（on/inject/effect/get/webServer/
 * sessions/set）都钉住，让"装配顺序错了/回调抛了/资源没回收"这类问题在
 * 单测阶段暴露，而不是等到真机 FATAL。
 */

import { Readable } from 'node:stream';

/**
 * 造一个上下文替身。
 * @param {Record<string, any>} [services] 预置服务
 */
export function makeCtx(services = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  /** @type {{label: string, dispose: Function}[]} */
  const effects = [];
  /** @type {any[]} */
  const routes = [];
  /** @type {any[]} */
  const sessionList = [];
  /** @type {string[]} */
  const logs = [];
  const registry = { ...services };

  const ctx = {
    logger: {
      warn: (...args) => logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ')),
      info: () => {},
      debug: () => {},
    },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) listeners.delete(event);
      };
    },
    inject(_names, callback) {
      callback(ctx);
    },
    effect(setup, label = 'effect') {
      const dispose = setup();
      effects.push({ label, dispose });
      return dispose;
    },
    get(name) {
      return registry[name];
    },
    set(name, value) {
      registry[name] = value;
    },
    webServer: {
      register(definition) {
        routes.push(definition);
        return () => {
          const index = routes.indexOf(definition);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    sessions: {
      list: () => sessionList,
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    dispose() {
      for (const entry of [...effects].reverse()) {
        try {
          entry.dispose();
        } catch (error) {
          logs.push(`dispose ${entry.label} failed: ${String(error)}`);
        }
      }
      effects.length = 0;
    },
    registry,
    routes,
    sessionList,
    logs,
    listeners,
    effects,
  };
  // 真实 cordis 上服务既是属性也能 ctx.get()；测试替身保持两者一致。
  for (const [key, value] of Object.entries(registry)) {
    if (!(key in ctx)) ctx[key] = value;
  }
  return ctx;
}

/**
 * 假会话：seq 就是数组下标，与宿主一致。
 * @param {string} id
 * @param {any[]} events
 * @param {{ isSeeded?: boolean }} [header]
 */
export function makeSession(id, events, header = {}) {
  return {
    id,
    header: { version: 4, ...header },
    inheritedEventCount: 0,
    snapshotEvents(from = 0) {
      return events.slice(from);
    },
    events,
  };
}

/** 事件工厂。 */
export const ev = {
  toolCall: (seq, time, name, callId, extra = {}) => ({
    type: 'tool/call',
    seq,
    time,
    data: { turn: 1, step: 1, callId, name, arguments: extra.arguments ?? '{}' },
  }),
  toolResult: (seq, time, callId, ok = true) => ({
    type: 'tool/result',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, isError: ok !== true, source: { kind: 'tool', callId } },
      meta: {},
    },
  }),
  turnStart: (seq, time) => ({ type: 'turn/start', seq, time, data: { turn: 1 } }),
  stepStart: (seq, time) => ({ type: 'step/start', seq, time, data: { turn: 1, step: 1 } }),
  assistant: (seq, time, usage) => ({ type: 'assistant/message', seq, time, data: { turn: 1, step: 1, message: {}, usage } }),
};

/**
 * 造一个最小 res 替身，收集状态码与响应体。
 */
export function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers ?? {};
    },
    end(body = '') {
      res.body = String(body);
    },
  };
  return res;
}

/**
 * 造一个可读请求体。
 * @param {{method?: string, url?: string, headers?: Record<string, string>, body?: string}} [options]
 */
export function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}
