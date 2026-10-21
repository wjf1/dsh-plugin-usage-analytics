import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../lib/store.js';
import { Collector } from '../lib/collector.js';
import { classifyTool, resolveConfig, dayKey } from '../lib/shared.js';
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

test('selfExclude=false 时本插件自身的调用照常计入', () => {
  const own = ev.toolCall(0, NOW, 'mcp__dsh-plugin-usage-analytics__report', 'c1');
  own.source = 'dsh-plugin-usage-analytics';
  const { ctx, store, collector } = setup({ config: { selfExclude: false }, sessionEvents: [own] });
  collector.attach();
  ctx.emit('session/created', makeSession('session-abc', [own]));

  assert.equal(store.row('daily', dayKey(NOW)).toolCalls, 1);
  assert.equal(collector.stats.selfExcluded, 0);
});

test('selfExclude=true 时排除本插件自身的调用（两种可判定标记）', () => {
  // 标记一：事件归属字段等于插件包名。
  const bySource = ev.toolCall(0, NOW, 'report', 'c1');
  bySource.source = 'dsh-plugin-usage-analytics';
  // 标记二：工具名落在本插件的 MCP 命名空间。
  const byTool = ev.toolCall(1, NOW, 'mcp__dsh-plugin-usage-analytics__summary', 'c2');
  // 对照：普通工具必须照常计入。
  const normal = ev.toolCall(2, NOW, 'read', 'c3');
  const normalResult = ev.toolResult(3, NOW + 10, 'c3', true);

  const events = [bySource, byTool, normal, normalResult];
  const { ctx, store, collector } = setup({ config: { selfExclude: true }, sessionEvents: events });
  collector.attach();
  ctx.emit('session/created', makeSession('session-abc', events));

  const daily = store.row('daily', dayKey(NOW));
  assert.equal(daily.toolCalls, 1, '只有非本插件的调用被计数');
  assert.equal(store.row('tool_daily', `${dayKey(NOW)}__read`).calls, 1);
  assert.equal(store.row('tool_daily', `${dayKey(NOW)}__report`), undefined, '自身调用不应建行');
  assert.equal(collector.stats.selfExcluded, 2);
});

test('工具参数只在截断范围内解析（不再整串 JSON.parse 卡住事件循环）', () => {
  // 正常的小参数照常拿到技能名。
  assert.equal(classifyTool('skill', '{"name":"weekly-report"}').capKey, 'weekly-report');

  // name 落在 4KB 之外：证明没有退回到整串解析（否则会读出 late-skill）。
  const far = `{"pad":"${'x'.repeat(5000)}","name":"late-skill"}`;
  assert.equal(classifyTool('skill', far).capKey, 'unknown');

  // 几 MB 的参数也不会被整串解析。
  const huge = JSON.stringify({ name: 'big-skill', blob: 'y'.repeat(4 * 1024 * 1024) });
  const started = Date.now();
  assert.equal(classifyTool('skill', huge).capKey, 'big-skill');
  assert.ok(Date.now() - started < 200, '截断后解析必须远快于整串解析');

  // 非 skill 工具根本不解析参数。
  assert.equal(classifyTool('read', huge).capKey, 'read');
});

test('采样成对：请求被抽掉时配对的响应一起丢，不产生孤儿结果', () => {
  const events = [];
  for (let i = 0; i < 200; i += 1) {
    events.push(ev.toolCall(i * 2, NOW, 'pwsh', `c${i}`));
    events.push(ev.toolResult(i * 2 + 1, NOW + 10, `c${i}`, true));
  }
  const { store, collector } = setup({ sessionEvents: events, config: { sampleRate: 0.5 } });
  collector.attach();

  const daily = store.row('daily', dayKey(NOW));
  assert.ok(daily.toolCalls > 0 && daily.toolCalls < 200, `调用数应被抽稀，实际 ${daily.toolCalls}`);
  // 成对抽稀的核心断言：每个计入的 call 都有配对的 result。
  // 独立采样时孤儿 result 会把 msSamples 抬到调用数之上，并把 ok:true 的结果
  // 记成不认识工具的失败。
  assert.equal(daily.msSamples, daily.toolCalls, '每条计入的调用都应有配对结果');
  assert.equal(daily.toolErrors, 0, '孤儿结果会被当成错误，这里必须为 0');
  assert.equal(collector.pendingCount, 0);
  assert.equal(collector.droppedCalls.size, 0, '被抽掉的占位应随配对清除');
});
