import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, detectProfile, name, resolveProfileName } from '../lib/index.js';
import { forgetDomain, memoryDomain } from '../lib/store.js';
import { API_PREFIX, PLUGIN_NAME, dayKey } from '../lib/shared.js';
import { ev, makeCtx, makeReq, makeRes, makeSession } from './harness.mjs';

const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();

/** 等一轮宏任务：setup 现在是 async，路由/服务注册发生在第一个 await 之后。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 造一个具备 storageDomain + webServer 的上下文。 */
async function setup(config = {}, services = {}) {
  let opens = 0;
  const ctx = makeCtx({
    storageDomain: {
      open(spec) {
        opens += 1;
        return memoryDomain(spec);
      },
    },
    ...services,
  });
  // 单例 domain 挂在 globalThis 上，测试之间必须隔离，否则上一个用例的数据会漏进来。
  forgetDomain(`plugin_analytics_${resolveProfileName(ctx)}`);
  apply(ctx, config);
  await settle();
  return { ctx, opens: () => opens };
}

test('apply 注册单条 prefix 路由、发布服务、暴露诊断', async () => {
  const { ctx } = await setup();
  assert.equal(name, PLUGIN_NAME);
  assert.equal(ctx.routes.length, 1, '只允许注册一条 prefix 路由（重复注册会拖垮插件树）');
  assert.equal(ctx.routes[0].kind, 'prefix');
  assert.equal(ctx.routes[0].path, API_PREFIX);
  assert.equal(typeof ctx.routes[0].handler, 'function');

  const service = ctx.registry.pluginAnalytics;
  assert.notEqual(service, undefined, '应发布 pluginAnalytics 服务');
  assert.equal(service.ready, true);
  const diag = service.diagnostics();
  assert.equal(diag.plugin, PLUGIN_NAME);
  assert.equal(diag.storage.kind, 'domain');
  assert.equal(diag.storage.layout, 'single');
  assert.equal(diag.fence, 'host+sec-fetch-site+origin');
});

test('采集链路端到端：事件 → 内存模型 → snapshot 可见', async () => {
  const { ctx } = await setup();
  const service = ctx.registry.pluginAnalytics;
  const session = makeSession('e2e', []);
  ctx.emit('session/created', session);
  ctx.emit('session/event', session, ev.toolCall(0, NOW, 'pwsh', 'c1'));
  ctx.emit('session/event', session, ev.toolResult(1, NOW + 500, 'c1', true));

  const snapshot = service.snapshot({ days: 7, now: NOW });
  assert.equal(snapshot.totals.toolCalls, 1);
  assert.equal(snapshot.totals.avgMs, 500);
  assert.equal(snapshot.tools[0].tool, 'pwsh');

  const written = await service.flush();
  assert.equal(written > 0, true, 'flush 应写入脏行');
  const diag = service.diagnostics();
  assert.equal(diag.storage.dirtyRows, 0);
  assert.equal(diag.storage.rows.daily >= 1, true);
  assert.equal(diag.collector.toolCalls, 1);
});

test('collect=false 时不注册事件订阅，但仍提供路由', async () => {
  const { ctx } = await setup({ collect: false });
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.listeners.has('session/event'), false);
  const diag = ctx.registry.pluginAnalytics.diagnostics();
  assert.equal(diag.settings.collect, false);
});

test('没有 storageDomain 时降级为内存模式而不是崩溃', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  await settle();
  const diag = ctx.registry.pluginAnalytics.diagnostics();
  assert.equal(diag.storage.kind, 'memory');
  assert.equal(diag.ready, true);
});

test('storageDomain.open 抛错（already-open 等）时同样降级', async () => {
  const ctx = makeCtx({
    storageDomain: {
      open() {
        throw Object.assign(new Error('domain already open'), { code: 'already-open' });
      },
    },
  });
  forgetDomain(`plugin_analytics_${resolveProfileName(ctx)}`);
  apply(ctx, {});
  await settle();
  const diag = ctx.registry.pluginAnalytics.diagnostics();
  assert.equal(diag.storage.kind, 'memory');
  assert.equal(ctx.logs.some((line) => line.includes('降级为内存模式')), true);
});

// 事故回归：真宿主 DomainFacility.open() 是 async，描述符校验失败是 reject 而不是同步 throw。
// 只要插件不 await，rejection 就会逃成 unhandledRejection，被宿主判成 fatal load failure 直接退进程。
test('storageDomain.open 返回 rejected Promise 时降级为内存，且不逃成 unhandledRejection', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const ctx = makeCtx({
      storageDomain: {
        async open() {
          throw Object.assign(
            new Error("invalid table name 'toolDaily' in unit 'plugin_analytics_default'"),
            { code: 'malformed-medium' },
          );
        },
      },
    });
    forgetDomain(`plugin_analytics_${resolveProfileName(ctx)}`);
    apply(ctx, {});
    await settle();
    await settle();
    const diag = ctx.registry.pluginAnalytics.diagnostics();
    assert.equal(diag.storage.kind, 'memory');
    assert.equal(diag.ready, true, '降级后插件仍应可用');
    assert.equal(rejections.length, 0, '打开失败必须被 catch，不能逃成 unhandledRejection');
    assert.equal(ctx.logs.some((line) => line.includes('降级为内存模式')), true);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('配置从 cordis 传入并逐键收敛', async () => {
  const { ctx } = await setup({ retentionDays: 30, sampleRate: 0.5, layout: 'per-record', mode: 'remote' });
  const diag = ctx.registry.pluginAnalytics.diagnostics();
  assert.equal(diag.settings.retentionDays, 30);
  assert.equal(diag.settings.sampleRate, 0.5);
  assert.equal(diag.storage.layout, 'per-record');
  assert.equal(diag.mode, 'remote');
});

test('dispose 逆序回收：路由注销、服务撤销、不留监听', async () => {
  const { ctx } = await setup();
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.listeners.has('session/event'), true);
  ctx.dispose();
  assert.equal(ctx.routes.length, 0, '路由应被注销');
  assert.equal(ctx.registry.pluginAnalytics, undefined, '服务应被撤销');
  assert.equal(ctx.listeners.has('session/event'), false, '会话订阅应被解除');
});

test('热重载：同一个 ctx 连续 apply 两次不会重复 open domain', async () => {
  let opens = 0;
  const ctx = makeCtx({
    storageDomain: {
      open(spec) {
        opens += 1;
        return memoryDomain(spec);
      },
    },
  });
  forgetDomain(`plugin_analytics_${resolveProfileName(ctx)}`);
  apply(ctx, {});
  await settle();
  apply(ctx, {});
  await settle();
  assert.equal(opens, 1, '第二次 apply 应复用 globalThis 单例 domain');
});

test('resolveProfileName 探测多来源并做字符集收敛', () => {
  const saved = { ...process.env };
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_NAME;
  delete process.env.DSH_PROFILE_DIR;
  try {
    assert.equal(resolveProfileName({ profile: { name: 'desktop' } }), 'desktop');
    assert.equal(resolveProfileName({ app: { profile: { name: 'work' } } }), 'work');
    assert.equal(resolveProfileName({ app: { profileName: 'team' } }), 'team');
    assert.equal(resolveProfileName({ profile: { name: 'a b/c' } }), 'a_b_c');
    assert.equal(resolveProfileName({}), 'default');
  } finally {
    for (const key of ['DSH_PROFILE', 'DSH_PROFILE_NAME', 'DSH_PROFILE_DIR']) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('detectProfile 分层探测并报告来源', () => {
  const saved = { ...process.env };
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_NAME;
  delete process.env.DSH_PROFILE_DIR;
  try {
    // config 覆盖优先级最高。
    assert.deepEqual(detectProfile({ profile: { name: 'desktop' } }, 'explicit'), { name: 'explicit', source: 'config' });
    assert.deepEqual(detectProfile({ profile: { name: 'desktop' } }), { name: 'desktop', source: 'profile' });
    assert.deepEqual(detectProfile({ app: { profileName: 'team' } }), { name: 'team', source: 'app.profileName' });
    // 桌面宿主拿不到 profile 服务时，可以从 baseDir 的 profiles/<name> 反推。
    assert.deepEqual(detectProfile({ baseDir: 'C:\\Users\\admin\\.dsh\\profiles\\web' }), { name: 'web', source: 'baseDir' });
    assert.deepEqual(detectProfile({}), { name: 'default', source: 'fallback' });
  } finally {
    for (const key of ['DSH_PROFILE', 'DSH_PROFILE_NAME', 'DSH_PROFILE_DIR']) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('回归：cordis 式受限上下文读未注入服务抛错时，插件仍完成装配', async () => {
  // 真机事故：resolveProfileName 里 ctx.profile 在 ?. 生效前就抛
  // "cannot get property profile without inject"，整个 inject 回调被中断，
  // 路由与服务都没注册，而且异常被 fiber 吞掉、外部完全看不到。
  const harness = makeCtx({});
  const strict = new Proxy(harness, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target) && !prop.startsWith('__')) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  // 清掉环境变量，让来源判定落在 fallback（与真机桌面宿主一致）。
  const saved = { ...process.env };
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_NAME', 'DSH_PROFILE_DIR']) delete process.env[key];
  try {
    apply(strict, {});
    await settle();
    assert.equal(harness.routes.length, 1, '路由必须注册成功');
    assert.equal(harness.routes[0].path, API_PREFIX, '路由前缀正确');
    const service = harness.registry.pluginAnalytics;
    assert.ok(service, '服务必须发布成功');
    assert.equal(service.diagnostics().profileSource, 'fallback');
  } finally {
    Object.assign(process.env, saved);
  }
});

test('会话事件写入后按本地日期汇总到今日行', async () => {
  const { ctx } = await setup();
  const service = ctx.registry.pluginAnalytics;
  const session = makeSession('day-test', []);
  ctx.emit('session/created', session);
  for (let i = 0; i < 3; i += 1) {
    ctx.emit('session/event', session, ev.toolCall(i * 2, NOW, 'read', `k${i}`));
    ctx.emit('session/event', session, ev.toolResult(i * 2 + 1, NOW + 10, `k${i}`, i !== 2));
  }
  await service.flush();
  const snapshot = service.snapshot({ days: 1, now: NOW });
  assert.equal(snapshot.today.day, dayKey(NOW));
  assert.equal(snapshot.today.toolCalls, 3);
  assert.equal(snapshot.today.toolErrors, 1);
  assert.equal(snapshot.sessions, 1);
});

test('改 collect 立即生效：无需重载插件', async () => {
  const { ctx } = await setup({ collect: true });
  assert.equal(ctx.listeners.has('session/event'), true);

  const post = async (body) => {
    const res = makeRes();
    await ctx.routes[0].handler(makeReq({
      method: 'POST',
      url: `${API_PREFIX}/settings`,
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    }), res);
    return JSON.parse(res.body);
  };

  const off = await post({ collect: false });
  assert.equal(off.ok, true);
  assert.equal(ctx.listeners.has('session/event'), false, '关闭采集应立即退订');

  const on = await post({ collect: true });
  assert.equal(on.ok, true);
  assert.equal(ctx.listeners.has('session/event'), true, '重新开启应立即订阅');
});
