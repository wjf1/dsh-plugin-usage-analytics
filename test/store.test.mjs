import test from 'node:test';
import assert from 'node:assert/strict';

import { AnalyticsStore, TABLES, compositeKey, forgetDomain, keyPart, memoryDomain, openStore } from '../lib/store.js';

/** 造一个用内存 domain 支撑的 store（等价真实 storageDomain）。 */
function makeStore() {
  const spec = {
    name: 'plugin_analytics_test',
    version: 1,
    tables: Object.fromEntries(Object.entries(TABLES).map(([key, value]) => [key, { valueSchema: value }])),
    global: { schema: TABLES.meta, initial: TABLES.meta.parse({}) },
  };
  const domain = memoryDomain(spec);
  return { store: new AnalyticsStore({ domainName: spec.name, domain }).load(), domain, spec };
}

test('put 标脏、flush 落盘、二次 flush 不重复写', async () => {
  const { store } = makeStore();
  assert.equal(store.isDirty, false);

  store.put('daily', '2026-10-20', { day: '2026-10-20', toolCalls: 3 });
  assert.equal(store.dirtyCount, 1);
  assert.equal(store.isDirty, true);

  const written = await store.flush();
  assert.equal(written, 1);
  assert.equal(store.dirtyCount, 0);
  assert.equal(store.isDirty, false);
  assert.equal(store.row('daily', '2026-10-20').toolCalls, 3);

  assert.equal(await store.flush(), 0, '没有脏行时不应产生写');
  assert.equal(store.stats.flushCount, 1);
});

test('schema 归一化：坏值回默认，绝不抛错', () => {
  const { store } = makeStore();
  store.put('daily', 'x', { day: 'x', toolCalls: 'NaN', turns: -5, events: null });
  const row = store.row('daily', 'x');
  assert.equal(row.toolCalls, 0);
  assert.equal(row.turns, 0);
  assert.equal(row.events, 0);
  // 非对象输入也不抛
  assert.doesNotThrow(() => TABLES.daily.parse(null));
  assert.doesNotThrow(() => TABLES.sessions.parse('garbage'));
});

test('重新 load 能从 domain 读回已落盘的行（持久化等价性）', async () => {
  const { store, domain, spec } = makeStore();
  store.put('tool_daily', '2026-10-20__pwsh', { day: '2026-10-20', tool: 'pwsh', calls: 7 });
  store.patchMeta({ installId: 'ins_test' });
  await store.flush();

  const reloaded = new AnalyticsStore({ domainName: spec.name, domain }).load();
  assert.equal(reloaded.row('tool_daily', '2026-10-20__pwsh').calls, 7);
  assert.equal(reloaded.meta.installId, 'ins_test');
});

test('remove 标脏并真正删除', async () => {
  const { store } = makeStore();
  store.put('daily', 'd1', { day: 'd1', events: 1 });
  await store.flush();
  store.remove('daily', 'd1');
  assert.equal(store.row('daily', 'd1'), undefined);
  assert.equal(await store.flush(), 1);
});

test('prune 按保留天数裁日表、按条数裁会话表', () => {
  const { store } = makeStore();
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime(); // 本地时间 2026-10-20
  store.put('daily', '2026-01-01', { day: '2026-01-01', events: 1 });
  store.put('daily', '2026-10-19', { day: '2026-10-19', events: 1 });
  for (let i = 0; i < 320; i += 1) {
    store.put('sessions', `s${i}`, { id: `s${i}`, last: i });
  }
  const removed = store.prune(30, now);
  assert.equal(store.row('daily', '2026-01-01'), undefined, '超期行应被删');
  assert.notEqual(store.row('daily', '2026-10-19'), undefined, '保留期内应保留');
  assert.ok(store.state.sessions.size <= 300, `会话超限应被裁，实际 ${store.state.sessions.size}`);
  assert.ok(removed >= 21);
});

test('reset 清空数据但保留安装标识', async () => {
  const { store } = makeStore();
  store.patchMeta({ installId: 'ins_keep' });
  store.put('daily', 'd1', { day: 'd1', events: 1 });
  store.put('sessions', 's1', { id: 's1' });
  store.reset();
  assert.equal(store.state.daily.size, 0);
  assert.equal(store.state.sessions.size, 0);
  assert.equal(store.meta.installId, 'ins_keep');
  await store.flush();
});

test('openStore 同 profile 复用同一 domain（HMR 不重复 open）', async () => {
  forgetDomain('plugin_analytics_desktop');
  let opens = 0;
  const ctx = {
    storageDomain: {
      open(spec) {
        opens += 1;
        return memoryDomain(spec);
      },
    },
  };
  const first = await openStore(ctx, { profileName: 'desktop', layout: 'single' });
  const second = await openStore(ctx, { profileName: 'desktop', layout: 'single' });
  assert.equal(opens, 1, '同 profile 只应 open 一次');
  assert.equal(first.domainName, second.domainName);
  assert.equal(first.meta.installId.length > 0, true, '首次应生成 installId');
  first.put('daily', 'd', { day: 'd', events: 1 });
  assert.equal(second.row('daily', 'd'), undefined, '未 flush 前内存不共享（各自一份模型）');
  await first.flush();
  const third = await openStore(ctx, { profileName: 'desktop', layout: 'single' });
  assert.equal(third.row('daily', 'd').events, 1, '复用 domain 后应读到已落盘的数据');
  assert.equal(opens, 1);
  forgetDomain('plugin_analytics_desktop');
});

test('openStore 不同 profile 使用不同 domain 名', async () => {
  forgetDomain('plugin_analytics_work');
  forgetDomain('plugin_analytics_second');
  const opened = [];
  const ctx = { storageDomain: { open(spec) { opened.push(spec.name); return memoryDomain(spec); } } };
  await openStore(ctx, { profileName: 'work', layout: 'single' });
  await openStore(ctx, { profileName: 'second', layout: 'single' });
  assert.deepEqual(opened, ['plugin_analytics_work', 'plugin_analytics_second']);
  forgetDomain('plugin_analytics_work');
  forgetDomain('plugin_analytics_second');
});

test('keyPart / compositeKey 落在 per-record 允许的字符集内', () => {
  assert.equal(keyPart('2026-10-20'), '2026-10-20');
  assert.equal(keyPart('工具/名称 x'), '______x'.replace(/_/g, '_'));
  assert.match(keyPart('a b/c'), /^[a-zA-Z0-9_-]+$/);
  assert.equal(compositeKey('2026-10-20', 'pwsh'), '2026-10-20__pwsh');
  assert.equal(keyPart(''), '_');
});

// 宿主 dsh-storage 的 UNIT_NAME_RE 是 /^[a-z][a-z0-9_]*$/，domain 名和表名都要过它；
// 早期用 toolDaily/capDaily 这类驼峰名，真机 open 时被 StorageError('malformed-medium') 拒绝，
// 进而触发 host 的 unhandledRejection → fatal load failure → 进程退出。
test('表名与 domain 名符合宿主 UNIT_NAME_RE 命名规则', () => {
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
  for (const table of Object.keys(TABLES)) {
    assert.match(table, UNIT_NAME_RE, `表名 '${table}' 不符合宿主命名规则`);
  }
  assert.doesNotMatch('toolDaily', UNIT_NAME_RE, '驼峰表名必须被规则拒绝（回归哨兵）');
  for (const profile of ['default', 'desktop', 'work']) {
    assert.match(`plugin_analytics_${profile}`, UNIT_NAME_RE);
  }
});

