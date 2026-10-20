/**
 * 宿主半入口。
 *
 * 装配顺序（每一步都能独立失败、失败只降级不阻塞宿主）：
 *   storageDomain.open → 采集订阅 → flush 周期 → HTTP 路由 → 服务发布
 *
 * 三条硬约束全部来自参考件的真实事故：
 *  - domain 必须挂 globalThis 单例（重复 open 会让宿主 FATAL）；
 *  - 任何资源都走 ctx.effect 的 disposer（禁用/热重载时干净退出）；
 *  - 采集回调禁止 I/O、禁止抛出（cordis emit 是 stop-on-throw）。
 */

import { API_PREFIX, DEFAULTS, PLUGIN_NAME, VERSION, resolveConfig, safeGet } from './shared.js';
import { createMemoryStore, forgetDomain, openStore } from './store.js';
import { Collector } from './collector.js';
import { ENDPOINTS, Routes } from './routes.js';
import { buildOverview } from './aggregate.js';

export const name = PLUGIN_NAME;

/**
 * 探测当前 profile 名，返回 `{ name, source }` 便于诊断。
 *
 * 多 profile 共用一个 `$DSH_HOME/storages`，domain 名必须带 profile 后缀（评审 P0-7）。
 * 实测桌面宿主进程里既没有 `ctx.profile` 也没有 `DSH_PROFILE`，
 * 所以这里排了 8 级来源；全拿不到才退 default，并允许 config.profileName 显式覆盖。
 * cordis 上下文读未 inject 的服务会抛错，因此一律走 safeGet。
 * @param {any} ctx
 * @param {string | null} [override] config.profileName
 * @returns {{ name: string, source: string }}
 */
export function detectProfile(ctx, override = null) {
  const explicit = normalizeProfile(override);
  if (explicit !== null) return { name: explicit, source: 'config' };
  const profile = safeGet(ctx, 'profile');
  const app = safeGet(ctx, 'app');
  const rawProfileDir = process.env.DSH_PROFILE_DIR;
  // 注意：可选链只护住 ?. 前面的那一段，`undefined.split()` 会直接抛
  // （这里真的踩过一次：真机装配静默失败，路由一条都没注册）。
  const profileDir = normalizeProfile(
    typeof rawProfileDir === 'string' && rawProfileDir !== '' ? rawProfileDir.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() : undefined,
  );
  const argv = process.argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length);
  const baseDir = safeGet(ctx, 'baseDir') ?? safeGet(app, 'baseDir');
  const baseDirText = typeof baseDir === 'string' ? baseDir : '';
  const fromBaseDir = baseDirText.match(/[\\/]profiles[\\/]([^\\/]+)/u)?.[1];
  const candidates = [
    ['profile', normalizeProfile(safeGet(profile, 'name'))],
    ['app.profile', normalizeProfile(safeGet(safeGet(app, 'profile'), 'name'))],
    ['app.profileName', normalizeProfile(safeGet(app, 'profileName'))],
    ['env.DSH_PROFILE', normalizeProfile(process.env.DSH_PROFILE)],
    ['env.DSH_PROFILE_NAME', normalizeProfile(process.env.DSH_PROFILE_NAME)],
    ['env.DSH_PROFILE_DIR', profileDir],
    ['argv', normalizeProfile(argv)],
    ['baseDir', normalizeProfile(fromBaseDir)],
  ];
  for (const [source, name] of candidates) {
    if (name !== null) return { name, source };
  }
  return { name: 'default', source: 'fallback' };
}

/**
 * 只要名字的兼容入口。
 * @param {any} ctx
 * @param {string | null} [override]
 * @returns {string}
 */
export function resolveProfileName(ctx, override = null) {
  return detectProfile(ctx, override).name;
}

/** profile 名会被拼进存储键名，这里压成安全字符集。 */
function normalizeProfile(value) {
  if (typeof value !== 'string') return null;
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 40);
  return safe === '' ? null : safe;
}

/**
 * cordis 插件入口。
 * @param {any} ctx
 * @param {Record<string, unknown>} [config] cordis.patch.yml 的 config 块
 */
export function apply(ctx, config) {
  const baseConfig = resolveConfig(config);
  const startedAt = Date.now();

  /**
   * 统一日志出口：插件内的任何异常都只能以 warn 形式落地。
   * @param {string} message
   * @param {unknown} [error]
   */
  const warn = (message, error) => {
    try {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : error === undefined ? '' : String(error);
      // logger 也是服务：未 inject 时直接读会抛错，必须 safeGet。
      safeGet(ctx, 'logger')?.warn?.(`[usage-analytics] ${message}${detail === '' ? '' : ` — ${detail}`}`);
    } catch {
      /* 日志失败不能影响主流程 */
    }
  };

  // webServer 是唯一"必需"的东西：没有它就没有面板数据来源，插件保持待命即可。
  ctx.inject(['webServer'], (scope) => {
    // setup 是 async（openStore 里要 await storageDomain.open）；
    // 同步 try/catch 抓不到 Promise rejection，必须用 .catch 兜底，
    // 否则 rejection 会逃到宿主顶层 unhandledRejection，被当成 fatal load failure 直接退进程。
    setup(scope).catch((error) => {
      // 兜底：任何装配期异常都只降级，绝不让插件"静默消失"（第一次真机加载失败就是静默的）。
      warn('插件装配失败，保持待命', error);
    });
  });

  /**
   * 真正的装配体。抽成函数是为了整体包一层保护：
   * cordis 的 fiber 会把回调异常吞成内部错误，外面看不见。
   * @param {any} scope 已注入 webServer 的子作用域
   */
  async function setup(scope) {
    const profileInfo = detectProfile(scope, baseConfig.profileName);
    const profileName = profileInfo.name;
    const layout = baseConfig.layout;

    // ── 1. 存储 ────────────────────────────────────────────────────────────
    /** @type {import('./store.js').AnalyticsStore} */
    let store;
    let storageKind = 'memory';
    let domainName = '';
    try {
      // 服务探测必须安全：cordis 上直接读未 inject 的服务会抛错。
      const service = safeGet(scope, 'storageDomain') ?? (typeof scope.get === 'function' ? scope.get('storageDomain') : undefined);
      if (service === undefined || typeof service.open !== 'function') {
        throw new Error('storageDomain 服务不可用');
      }
      // storageDomain.open() 是 async：必须 await，否则 descriptor 校验失败会变成
      // 无人处理的 rejection（宿主按 fatal load failure 处理），同步 catch 兜不住。
      store = await openStore(scope, { profileName, layout: baseConfig.layout, warn });
      storageKind = 'domain';
      domainName = store.domainName;
    } catch (error) {
      warn('存储不可用，降级为内存模式（重启即丢）', error);
      store = createMemoryStore(warn);
    }

    // ── 2. 设置（cordis config ← 面板设置覆盖） ─────────────────────────────
    /** 面板改过的设置持久化在 meta.settings，优先级高于 patch 里的 config。 */
    const settings = { ...baseConfig, ...(store.meta.settings ?? {}) };
    const saveSettings = (patch) => {
      Object.assign(settings, patch);
      store.patchMeta({ settings: { ...(store.meta.settings ?? {}), ...patch } });
    };

    // ── 3. 采集 ────────────────────────────────────────────────────────────
    const collector = new Collector({ ctx: scope, store, config: settings, warn });
    const stats = {
      startedAt,
      profileName,
      profileSource: profileInfo.source,
      layout,
      storageKind,
      domainName,
    };

    // ── 4. flush 周期 ──────────────────────────────────────────────────────
    let flushing = null;
    let lastPruneAt = 0;
    /**
     * 落盘一次（并发去重）。
     * @param {string} [reason]
     * @returns {Promise<number>}
     */
    const flushNow = (reason = 'manual') => {
      if (flushing !== null) return flushing;
      flushing = (async () => {
        try {
          const written = await store.flush();
          // 每小时最多裁剪一次，避免每轮都全表扫描。
          if (Date.now() - lastPruneAt > 3_600_000) {
            lastPruneAt = Date.now();
            store.prune(settings.retentionDays);
          }
          return written;
        } catch (error) {
          warn(`flush 失败（${reason}）`, error);
          return 0;
        } finally {
          flushing = null;
        }
      })();
      return flushing;
    };

    // ── 5. 诊断快照 ────────────────────────────────────────────────────────
    const diagnostics = () => ({
      plugin: PLUGIN_NAME,
      version: VERSION,
      ready: true,
      mode: settings.mode,
      uptimeMs: Date.now() - startedAt,
      profileName,
      profileSource: profileInfo.source,
      storage: {
        kind: storageKind,
        domain: domainName,
        layout,
        writes: store.stats.writes,
        flushes: store.stats.flushCount,
        lastFlushAt: store.stats.lastFlushAt,
        dirtyRows: store.dirtyCount,
        rows: {
          daily: store.state.daily.size,
          tool_daily: store.state.tool_daily.size,
          cap_daily: store.state.cap_daily.size,
          sessions: store.state.sessions.size,
        },
      },
      settings: { ...settings },
      collector: { ...collector.stats, pending: collector.pendingCount, adopted: collector.adopted.size },
      meta: {
        installId: store.meta.installId,
        createdAt: store.meta.createdAt,
        cursors: Object.keys(store.meta.cursors ?? {}).length,
        dropped: store.meta.dropped,
        sampled: store.meta.sampled,
      },
      fence: 'host+sec-fetch-site+origin',
      endpoints: ENDPOINTS,
    });

    // ── 6. 路由 ────────────────────────────────────────────────────────────
    const routes = new Routes({
      store,
      getStats: diagnostics,
      settings,
      saveSettings,
      flushNow,
      warn,
    });

    // ── 7. 资源登记（disposer 逆序执行：路由 → flush → 采集 → 存储关闭） ──────
    scope.effect(() => {
      let detach = () => {};
      if (settings.collect) {
        detach = collector.attach({ onFlush: () => void flushNow('session/flush') });
      } else {
        warn('collect=false，只提供查询与面板，不采集事件');
      }
      return () => detach();
    }, 'usage-analytics: collector');

    scope.effect(() => {
      const interval = Math.max(2000, Math.floor(settings.flushIntervalMs));
      const timer = setInterval(() => void flushNow('timer'), interval);
      timer.unref?.();
      return async () => {
        clearInterval(timer);
        await flushNow('dispose');
        await store.close();
        if (storageKind === 'domain' && domainName !== '') forgetDomain(domainName);
      };
    }, 'usage-analytics: flush loop');

    scope.effect(() => {
      const dispose = scope.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: routes.handle });
      return () => {
        try {
          dispose?.();
        } catch (error) {
          warn('路由卸载失败', error);
        }
      };
    }, 'usage-analytics: http routes');

    // ── 8. 服务发布（可选；宿主不支持 ctx.set 时静默跳过） ────────────────────
    const service = {
      name: PLUGIN_NAME,
      mode: settings.mode,
      ready: true,
      /** 概览快照，供别的插件在进程内直接读。 */
      snapshot: (options) => buildOverview(store, options ?? {}),
      flush: () => flushNow('service'),
      diagnostics,
      defaults: { ...DEFAULTS },
    };
    try {
      if (typeof scope.set === 'function') {
        scope.effect(() => {
          // cordis 4 要求先 provide 才能 set，否则抛 "cannot set property ... without provide"。
          try {
            if (typeof scope.provide === 'function') scope.provide('pluginAnalytics');
            scope.set('pluginAnalytics', service);
          } catch (error) {
            warn('发布 pluginAnalytics 服务失败（不影响主功能）', error);
            return () => {};
          }
          return () => {
            try {
              scope.set('pluginAnalytics', undefined);
            } catch {
              /* 卸载期忽略 */
            }
          };
        }, 'usage-analytics: service');
      }
    } catch (error) {
      warn('注册 pluginAnalytics 服务失败（不影响主功能）', error);
    }
  }
}

export { resolveConfig };
