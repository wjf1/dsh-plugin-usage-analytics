import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../lib/store.js';
import { Collector } from '../lib/collector.js';
import { resolveConfig, dayKey } from '../lib/shared.js';
import { ev, makeCtx, makeSession } from './harness.mjs';

const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();

/** 造一套 collector + 假会话，便于逐条驱动。 */
function setup({ config = {}, sessionEvents = [] } = {}) {
  const ctx = makeCtx();
  const store = createMemoryStore();
  const collector = new Collector({ ctx, store, config: resolveConfig(config), warn: () => {} });
  const session = makeSession('session-abc', sessionEvents);
  ctx.sessionList.push(session);
  return { ctx, store, collector, session };
}

test('tool/call 与 tool/result 按 callId 配对，得到调用数、错误数与耗时', () => {
  const t0 = NOW;
  const events = [
    ev.turnStart(0, t0),
    ev.stepStart(1, t0),
    ev.toolCall(2, t0, 'pwsh', 'call_1'),
    ev.toolResult(3, t0 + 1200, 'call_1', true),
    ev.toolCall(4, t0, 'pwsh', 'call_2'),
    ev.toolResult(5, t0 + 300, 'call_2', false),
  ];
  const { ctx, store, collector } = setup({ sessionEvents: events });
  collector.attach();
  ctx.emit('session/created', makeSession('session-abc', events));

  const daily = store.row('daily', dayKey(t0));
  assert.equal(daily.toolCalls, 2);
  assert.equal(daily.toolErrors, 1);
  assert.equal(daily.turns, 1);
  assert.equal(daily.steps, 1);
  assert.equal(daily.ms, 1500);
  assert.equal(daily.msSamples, 2);

  const tool = store.row('tool_daily', `${dayKey(t0)}__pwsh`);
  assert.equal(tool.calls, 2);
  assert.equal(tool.errors, 1);
  assert.equal(tool.maxMs, 1200);

  assert.equal(collector.pendingCount, 0, '结果到齐后不应残留待配对调用');
  assert.equal(collector.stats.toolCalls, 2);
  assert.equal(collector.stats.toolResults, 2);
});

test('live 事件走 session/event，并且 seq 幂等（重复投递不重复计数）', () => {
  const { ctx, store, collector } = setup();
  collector.attach();
  const session = makeSession('s-live', []);
  ctx.emit('session/created', session);

  const call = ev.toolCall(0, NOW, 'read', 'c1');
  ctx.emit('session/event', session, call);
  ctx.emit('session/event', session, call); // 同 seq 再来一次
  ctx.emit('session/event', session, ev.toolResult(1, NOW + 100, 'c1', true));

  assert.equal(store.row('daily', dayKey(NOW)).toolCalls, 1, '同一 seq 只能算一次');
  assert.equal(collector.stats.toolCalls, 1);
  assert.equal(store.row('tool_daily', `${dayKey(NOW)}__read`).calls, 1);
});

test('回填：新 collector 从持久游标之后继续，不重复消费历史', () => {
  const events = [
    ev.toolCall(0, NOW, 'pwsh', 'c1'),
    ev.toolResult(1, NOW + 100, 'c1', true),
    ev.toolCall(2, NOW + 200, 'pwsh', 'c2'),
    ev.toolResult(3, NOW + 400, 'c2', true),
  ];
  const { ctx, store, collector } = setup({ sessionEvents: events });
  collector.attach();
  assert.equal(store.row('daily', dayKey(NOW)).toolCalls, 2, 'attach 应回填已有会话');

  // 模拟进程重启：新 store（复用持久化 meta）+ 新 collector
  const collector2 = new Collector({ ctx, store, config: resolveConfig({}), warn: () => {} });
  const backfilledBefore = collector2.stats.backfilled;
  ctx.sessionList.length = 0;
  ctx.sessionList.push(makeSession('session-abc', events));
  collector2.attach();
  assert.equal(collector2.stats.backfilled, backfilledBefore, '游标已覆盖全部 seq，不应再次回填');
  assert.equal(store.row('daily', dayKey(NOW)).toolCalls, 2, '计数不应翻倍');
});

test('回填：没有游标时从 0 全量消费一次', () => {
  const events = [
    ev.toolCall(0, NOW, 'grep', 'c1'),
    ev.toolResult(1, NOW + 50, 'c1', true),
  ];
  const { store, collector } = setup({ sessionEvents: events });
  assert.equal(collector.stats.backfilled, 0);
  collector.attach();
  assert.equal(collector.stats.backfilled, 2);
  assert.equal(store.row('daily', dayKey(NOW)).toolCalls, 1);
});

test('fork：isSeeded 会话从 inheritedEventCount 之后开始消费', () => {
  const events = [
    ev.toolCall(0, NOW, 'pwsh', 'parent-call'),
    ev.toolResult(1, NOW + 10, 'parent-call', true),
    ev.toolCall(2, NOW + 20, 'pwsh', 'child-call'),
    ev.toolResult(3, NOW + 60, 'child-call', true),
  ];
  const { store, collector } = setup();
  const child = makeSession('child', events, { isSeeded: true });
  child.inheritedEventCount = 2;
  collector.adopt(child);
  assert.equal(store.row('daily', dayKey(NOW)).toolCalls, 1, '只算子会话新增的 1 次调用');
});

test('采样：sampleRate=0.5 时统计 sampled 且只消费部分事件', () => {
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push(ev.toolCall(i * 2, NOW, 'pwsh', `c${i}`));
    events.push(ev.toolResult(i * 2 + 1, NOW + 10, `c${i}`, true));
  }
  const { store, collector } = setup({ sessionEvents: events, config: { sampleRate: 0.5 } });
  collector.attach();
  const calls = store.row('daily', dayKey(NOW)).toolCalls;
  assert.ok(collector.stats.sampled > 0, '应有被抽稀的事件');
  assert.ok(calls > 0 && calls < 40, `采样后调用数应在 0..40 之间，实际 ${calls}`);
  assert.equal(store.meta.sampled > 0, true, 'sampled 计数应持久化到 meta');
});

test('采集回调抛异常会被吞掉并计入 errors（不能击穿 cordis emit）', () => {
  const { ctx, collector } = setup();
  collector.attach();
  let reached = false;
  ctx.on('session/created', () => {
    reached = true;
  });
  // 故意给一个会触发内部异常的会话对象
  const broken = {
    id: 'broken',
    get snapshotEvents() {
      throw new Error('boom');
    },
  };
  assert.doesNotThrow(() => ctx.emit('session/created', broken));
  assert.equal(collector.stats.errors > 0, true);
  assert.equal(reached, true, '后续订阅者必须仍然收到事件');
});

test('session/disposed 清掉该会话的待配对调用', () => {
  const { ctx, store, collector } = setup();
  collector.attach();
  const session = makeSession('s1', []);
  ctx.emit('session/created', session);
  ctx.emit('session/event', session, ev.toolCall(0, NOW, 'pwsh', 'orphan'));
  assert.equal(collector.pendingCount, 1);
  ctx.emit('session/disposed', session);
  assert.equal(collector.pendingCount, 0);
  assert.equal(collector.adopted.has(collector.sidOf(session)), false);
  assert.equal(store.row('sessions', collector.sidOf(session)).id.length > 0, true);
});

test('会话 id 落盘前被哈希，原始 id 不出现在键里', () => {
  const { collector, store } = setup();
  const session = makeSession('super-secret-uuid', []);
  collector.adopt(session);
  const sid = collector.sidOf(session);
  assert.equal(sid.includes('super-secret-uuid'), false);
  assert.match(sid, /^[0-9a-f]{16}$/);
  assert.notEqual(store.row('sessions', sid), undefined);
});

test('单日事件超限后只记 dropped，不再累加调用', () => {
  const { store, collector } = setup({ config: { maxEventsPerDay: 1000 } });
  store.put('daily', dayKey(NOW), { day: dayKey(NOW), events: 1000 });
  const session = makeSession('s-limit', []);
  collector.consume(session, ev.toolCall(0, NOW, 'pwsh', 'c1'));
  assert.equal(collector.stats.dropped, 1);
  assert.equal(store.row('daily', dayKey(NOW)).toolCalls, 0);
});
