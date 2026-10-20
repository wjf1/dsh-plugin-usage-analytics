/**
 * 共享常量与纯函数（仅宿主半加载）。
 *
 * 设计取向：
 *  - 这里只允许 `node:` 内置模块（插件零运行时依赖，不引宿主私有包）。
 *  - 所有函数必须同步、无 I/O：采集热路径会直接调用它们。
 */
import { createHash } from 'node:crypto';

/** 插件包名，用于日志前缀、domain 名、客户端 slot key。 */
export const PLUGIN_NAME = 'dsh-plugin-usage-analytics';

/** 插件版本：与 package.json 的 version 保持一致（诊断与环境接口都读它）。 */
export const VERSION = '0.1.1';

/** HTTP 前缀：客户端固定请求 `${API_PREFIX}/<动作>`。 */
export const API_PREFIX = '/dsh-plugin-usage-analytics/api';

/** 存储 domain 名前缀；真实名字会拼上 profile，避免多 profile 互相覆盖。 */
export const DOMAIN_PREFIX = 'plugin_analytics_';

/**
 * 日表保留上限（表内行数，不是天数）：即便 retentionDays 配得很大，
 * 也不会把内存模型撑爆。超出后从最旧的日期开始裁。
 */
export const MAX_DAILY_ROWS = 800;

/** 会话表保留条数。 */
export const MAX_SESSION_ROWS = 300;

/** 待配对工具调用表上限：防止异常会话（只 call 不 result）让内存只增不减。 */
export const MAX_PENDING_CALLS = 2000;

/** 一次 flush 最多写多少行；剩余留给下一个周期，避免长任务阻塞事件循环。 */
export const MAX_FLUSH_ROWS = 400;

/** 默认配置。cordis.patch.yml 的 config 逐键覆盖。 */
export const DEFAULTS = Object.freeze({
  /** local = 只写本机；remote/opt-in 预留，未实现上报链路时一律按 local 处理。 */
  mode: 'local',
  /** 日表保留天数（聚合数据）。 */
  retentionDays: 90,
  /** 采样率 0..1；1 表示全量采集。 */
  sampleRate: 1,
  /** 单日聚合事件上限超过即丢弃并计数。 */
  maxEventsPerDay: 200000,
  /** 脏表合并写盘间隔（毫秒）。 */
  flushIntervalMs: 10000,
  /** 是否在面板里显示自己（本插件）的调用。 */
  selfExclude: false,
  /** 采集开关：false 时只注册路由与面板，不订阅会话事件。 */
  collect: true,
  /** 存储布局：single = 整 unit 一个 JSON；per-record = 每行一个文件。 */
  layout: 'single',
  /** 面板是否在侧栏显示入口。 */
  panelEnabled: true,
  /**
   * profile 名覆盖（null = 自动探测）。
   * 多 profile 共用一个 `$DSH_HOME/storages`，domain 名必须带 profile 后缀；
   * 桌面宿主的进程环境里既没有 DSH_PROFILE 也没有 profile 服务，
   * 自动探测会退到 default，因此留这个显式开关给多 profile 用户。
   */
  profileName: null,
});

/**
 * 合并配置：只接受已知键，类型不对回退默认值，避免脏配置把插件带崩。
 * @param {Record<string, unknown> | undefined} input cordis 传入的 config
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(input) {
  const cfg = { ...DEFAULTS };
  if (input === null || typeof input !== 'object') return cfg;
  const num = (key, min, max) => {
    const value = Number(input[key]);
    if (Number.isFinite(value)) cfg[key] = Math.min(max, Math.max(min, value));
  };
  const bool = (key) => {
    if (typeof input[key] === 'boolean') cfg[key] = input[key];
  };
  if (typeof input.mode === 'string' && ['local', 'remote', 'opt-in'].includes(input.mode)) {
    cfg.mode = input.mode;
  }
  num('retentionDays', 1, 400);
  num('sampleRate', 0, 1);
  num('maxEventsPerDay', 1000, 5_000_000);
  num('flushIntervalMs', 2000, 300_000);
  bool('selfExclude');
  bool('collect');
  bool('panelEnabled');
  if (input.layout === 'single' || input.layout === 'per-record') cfg.layout = input.layout;
  // profileName 会被拼进 storage domain 名，只允许安全字符，避免存储层拒绝键名。
  if (typeof input.profileName === 'string' && /^[a-zA-Z0-9_-]{1,40}$/u.test(input.profileName.trim())) {
    cfg.profileName = input.profileName.trim();
  }
  return cfg;
}

/**
 * 本地时区的 YYYY-MM-DD。
 * 用本地日而不是 UTC 日：看板使用者关心的是"我这一天的用量"。
 * @param {number} ts 毫秒时间戳
 * @returns {string}
 */
export function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 把"昨天/前 N 天"的日期键算出来，用于趋势查询补齐空白天。
 * @param {number} days 天数，>=1
 * @param {number} [now] 基准时间戳
 * @returns {string[]} 从旧到新
 */
export function recentDays(days, now = Date.now()) {
  const out = [];
  const base = new Date(now);
  base.setHours(12, 0, 0, 0); // 中午取日，绕开夏令时/跨日边界
  const span = Math.max(1, Math.min(400, Math.floor(days)));
  for (let i = span - 1; i >= 0; i -= 1) {
    out.push(dayKey(base.getTime() - i * 86_400_000));
  }
  return out;
}

/**
 * 把任意字符串折叠成稳定短标识（sha256 前 16 位十六进制）。
 * 隐私用途：会话 id 落盘前先哈希，原始 id 不离开内存。
 * @param {string} input
 * @returns {string}
 */
export function shortHash(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

/** 数值收敛：非有限数一律回 default。 */
export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 非负整数收敛。 */
export function uint(value, fallback = 0) {
  const n = Math.floor(num(value, fallback));
  return n >= 0 ? n : fallback;
}

/** 字符串收敛：截断到上限，非字符串返回空串。 */
export function str(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * 安全读取 cordis 上下文上的服务属性。
 *
 * cordis 的 ctx 是受限代理：**读取一个没有 inject 声明的服务会直接抛错**
 * （`cannot get property "x" without inject`），而不是返回 undefined。
 * 这是本插件第一次真机加载失败的唯一原因——`ctx.profile?.name` 在
 * `?.` 生效前就已经抛出，整个 inject 回调被中断，路由与服务都没能注册。
 *
 * 所以任何"探测式"的服务读取都必须走这里：读不到就是 undefined。
 * @template T
 * @param {any} ctx
 * @param {string} key
 * @returns {T | undefined}
 */
export function safeGet(ctx, key) {
  if (ctx === undefined || ctx === null) return undefined;
  try {
    return ctx[key];
  } catch {
    return undefined;
  }
}

/** 安全 JSON.parse：失败返回 undefined，绝不抛出（采集热路径不许有异常）。 */
export function tryParseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 工具名归一化 + 能力归因（对应设计 §6.1 C3，按评审 P1-10 合并了 C4/C5/C6）。
 *
 * 归因口径（评审 P0-1 结论）：宿主原生工具没有注册方信息，
 * 只能按名字分类，不做"哪个插件提供的"这种做不到的归因。
 *
 * @param {string} name 工具名
 * @param {string} [rawArguments] tool/call 的 arguments 原始 JSON 字符串
 * @returns {{ tool: string, cap: 'native'|'mcp'|'skill', capKey: string }}
 */
export function classifyTool(name, rawArguments) {
  const tool = str(name, 120) || 'unknown';
  if (tool.startsWith('mcp__')) {
    // mcp__<server>__<tool>；server 里可能含 __，从右往左切最后一段当 tool。
    const rest = tool.slice(5);
    const cut = rest.lastIndexOf('__');
    const server = cut > 0 ? rest.slice(0, cut) : rest;
    const leaf = cut > 0 ? rest.slice(cut + 2) : '';
    return { tool, cap: 'mcp', capKey: `${server}${leaf ? `/${leaf}` : ''}`.slice(0, 160) };
  }
  if (tool === 'skill') {
    // 技能通过 skill 工具触发：名字在 arguments.name，解析不到就记 'unknown'。
    const parsed = tryParseJson(rawArguments);
    const skillName = str(parsed && typeof parsed === 'object' ? parsed.name : '', 120) || 'unknown';
    return { tool, cap: 'skill', capKey: skillName };
  }
  return { tool, cap: 'native', capKey: tool };
}

/** 百分比：0..1 转 0..100 并保留一位小数。 */
export function pct(part, whole) {
  const w = num(whole);
  if (w <= 0) return 0;
  return Math.round((num(part) / w) * 1000) / 10;
}

/** 平均耗时（毫秒），无样本返回 null，让客户端显示 "—"。 */
export function avgMs(sum, samples) {
  const n = num(samples);
  if (n <= 0) return null;
  return Math.round(num(sum) / n);
}
