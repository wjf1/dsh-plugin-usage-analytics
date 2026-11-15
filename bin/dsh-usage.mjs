#!/usr/bin/env node
/**
 * dsh-usage：把本地采集的 DSH 用量日表导出为 JSONL / CSV。
 *
 * 与面板 / HTTP 接口同源：不重新实现数据解析，直接复用 lib/store.js 的
 * AnalyticsStore（schema 归一化 + meta 迁移）读取宿主落盘的 storage 快照。
 *
 * 数据来源（single 布局的落盘 JSON，结构见 lib/store.js 的注释与 README）：
 *   { unit: { name, version }, global: { meta 行 }, tables: { daily, tool_daily, cap_daily, sessions } }
 * 默认按 `<DSH_HOME>/storages/plugin_analytics_<profile>.json` 探测，
 * `--file` 可显式指定任意快照路径（测试/备份文件也能导）。
 *
 * 退出码：0 成功；1 数据文件缺失或损坏；2 用法错误。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { AnalyticsStore, keyPart } from '../lib/store.js';
import { DOMAIN_PREFIX } from '../lib/shared.js';

/** 支持的输出格式。 */
export const FORMATS = Object.freeze(['jsonl', 'csv']);

/**
 * 日表字段与列序：与 lib/store.js 的 dailySchema 保持一致。
 * tokensIn/tokensOut 是 token 计数；toolCalls/steps 近似"请求数"口径。
 */
export const DAILY_FIELDS = Object.freeze([
  'day',
  'events',
  'toolCalls',
  'toolErrors',
  'steps',
  'turns',
  'sessions',
  'tokensIn',
  'tokensOut',
  'ms',
  'msSamples',
  'maxMs',
  'panels',
  'commands',
  'mcp',
  'skills',
  'dropped',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** 用法错误：exit 2。 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 数据错误（文件缺失 / 损坏 / 布局不符）：exit 1。 */
export class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

/** 帮助文本。 */
export function usage() {
  return `dsh-usage — 导出本地 DSH 用量日表（JSONL / CSV）

用法：
  dsh-usage <jsonl|csv> [选项]

选项：
  --from <YYYY-MM-DD>   起始日期（含），缺省不限
  --to <YYYY-MM-DD>     结束日期（含），缺省不限
  --out <file>          写入文件；缺省输出到 stdout
  --file <path>         落盘 JSON 路径（single 布局快照）；缺省按 --profile 探测
  --profile <name>      存储 profile 名（默认 default）
  --home <dir>          DSH 主目录（默认 $DSH_HOME，否则 ~/.dsh）
  -h, --help            显示本帮助

数据字段（CSV 列序 / JSONL 键序）：
  ${DAILY_FIELDS.join(', ')}
`;
}

/**
 * 解析命令行参数。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ format?: string, from?: string, to?: string, out?: string, profile?: string, file?: string, home?: string, help?: boolean }}
 */
export function parseArgs(argv) {
  const options = { format: undefined, from: undefined, to: undefined, out: undefined, profile: undefined, file: undefined, home: undefined, help: false };
  const withValue = new Set(['--from', '--to', '--out', '--profile', '--file', '--home']);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (withValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new UsageError(`选项 ${arg} 缺少值`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`未知选项 ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (options.help) return options;
  if (positional.length === 0) throw new UsageError('缺少格式参数（jsonl|csv）');
  if (positional.length > 1) throw new UsageError(`多余的参数：${positional.slice(1).join(' ')}`);
  const format = positional[0].toLowerCase();
  if (!FORMATS.includes(format)) {
    throw new UsageError(`未知格式 '${positional[0]}'，支持：${FORMATS.join(' / ')}`);
  }
  options.format = format;
  for (const key of ['from', 'to']) {
    if (options[key] !== undefined && !DATE_RE.test(options[key])) {
      throw new UsageError(`--${key} 必须是 YYYY-MM-DD，收到 '${options[key]}'`);
    }
  }
  if (options.from !== undefined && options.to !== undefined && options.from > options.to) {
    throw new UsageError(`--from ${options.from} 晚于 --to ${options.to}`);
  }
  return options;
}

/**
 * 解析数据快照路径：--file 优先，否则按 home/profile 探测。
 * @param {{ file?: string, home?: string, profile?: string }} options
 * @returns {{ file: string, source: 'file'|'home' }}
 */
export function resolveDataFile(options) {
  if (options.file !== undefined && options.file !== '') return { file: options.file, source: 'file' };
  const home = options.home !== undefined && options.home !== '' ? options.home : process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const profile = keyPart(options.profile === undefined || options.profile === '' ? 'default' : options.profile);
  return { file: path.join(home, 'storages', `${DOMAIN_PREFIX}${profile}.json`), source: 'home' };
}

/**
 * 读取并校验 single 布局快照。文件缺失时列出同目录候选，方便找对 profile。
 * @param {string} file
 * @returns {{ unit?: any, global?: any, tables: Record<string, Record<string, any>> }}
 */
export function readSnapshot(file) {
  if (!existsSync(file)) {
    const detail = [];
    const dir = path.dirname(file);
    try {
      const candidates = readdirSync(dir).filter((name) => name.startsWith(DOMAIN_PREFIX) && name.endsWith('.json'));
      if (candidates.length > 0) detail.push(`可用的数据文件：${candidates.join(', ')}`);
    } catch {
      // 目录也不存在时不追加候选信息。
    }
    throw new DataError(`数据文件不存在：${file}${detail.length > 0 ? `\n${detail.join('\n')}` : ''}`);
  }
  if (path.extname(file).toLowerCase() !== '.json') {
    throw new DataError(`不是 single 布局的落盘 JSON（.json）：${file}。本工具只读 single 布局快照，per-record 布局请先合并或用 --file 指向合并后的 JSON`);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DataError(`数据文件不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (doc === null || typeof doc !== 'object' || doc.tables === null || typeof doc.tables !== 'object') {
    throw new DataError(`数据文件缺少 tables 表结构（不是本插件的 single 布局快照）：${file}`);
  }
  return doc;
}

/**
 * 把快照包装成只读 domain：AnalyticsStore.load() 只需要
 * table(name).entries() 与 global.get() 两个读接口。
 */
function domainFromSnapshot(doc) {
  const tables = doc.tables;
  const unitName = typeof doc.unit?.name === 'string' && doc.unit.name !== '' ? doc.unit.name : `${DOMAIN_PREFIX}cli`;
  return {
    table(name) {
      const rows = typeof tables[name] === 'object' && tables[name] !== null ? tables[name] : {};
      const keys = Object.keys(rows);
      return {
        get: (key) => rows[key],
        entries: () => Object.entries(rows),
        keys: () => keys,
        get size() {
          return keys.length;
        },
      };
    },
    global: { get: () => (typeof doc.global === 'object' && doc.global !== null ? doc.global : {}) },
    close: () => {},
  };
}

/**
 * 读取快照里的日表：schema 归一化 + 日期升序 + from/to 过滤。
 * @param {object} [options]
 * @param {string} [options.file] 快照路径（缺省按 home/profile 探测）
 * @param {string} [options.home] DSH 主目录
 * @param {string} [options.profile] 存储 profile 名
 * @param {string} [options.from] 起始日期（含）
 * @param {string} [options.to] 结束日期（含）
 * @param {(msg: string) => void} [options.warn] 存储/迁移告警出口
 * @returns {{ rows: Array<Record<string, any>>, file: string, store: AnalyticsStore }}
 */
export function loadDailyRows(options = {}) {
  const { file } = resolveDataFile(options);
  const doc = readSnapshot(file);
  /** @type {string[]} */
  const warnings = [];
  const store = new AnalyticsStore({
    domainName: domainNameOf(doc),
    domain: domainFromSnapshot(doc),
    warn: (msg) => warnings.push(msg),
  });
  store.load();
  for (const msg of warnings) options.warn?.(msg);
  const rows = [...store.state.daily.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .filter((row) => (options.from === undefined || row.day >= options.from) && (options.to === undefined || row.day <= options.to));
  return { rows, file, store };
}

function domainNameOf(doc) {
  const name = doc.unit?.name;
  return typeof name === 'string' && name !== '' ? name : `${DOMAIN_PREFIX}cli`;
}

/** 按固定列序抽取一行日表。 */
function pickFields(row) {
  const out = {};
  for (const field of DAILY_FIELDS) out[field] = row[field];
  return out;
}

/** 导出 JSONL：每日一行 `{kind:'daily', ...日表字段}`，与 REST /export 的 NDJSON 形态一致。 */
export function toJsonl(rows) {
  const lines = rows.map((row) => JSON.stringify({ kind: 'daily', ...pickFields(row) }));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** CSV 引号转义：含逗号/引号/换行的值整体加引号。 */
export function csvEscape(value) {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** 导出 CSV：首行表头，随后每日一行（日期升序）。 */
export function toCsv(rows) {
  const lines = [DAILY_FIELDS.join(',')];
  for (const row of rows) lines.push(DAILY_FIELDS.map((field) => csvEscape(row[field])).join(','));
  return `${lines.join('\n')}\n`;
}

/** 渲染输出。 */
export function render(format, rows) {
  return format === 'csv' ? toCsv(rows) : toJsonl(rows);
}

/**
 * CLI 主入口。
 * @param {string[]} argv
 * @returns {number} 进程退出码
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`dsh-usage: ${error.message}\n\n${usage()}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  let loaded;
  try {
    loaded = loadDailyRows(options);
  } catch (error) {
    if (error instanceof DataError) {
      process.stderr.write(`dsh-usage: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const body = render(options.format, loaded.rows);
  if (options.out !== undefined && options.out !== '') {
    writeFileSync(options.out, body, 'utf8');
    process.stderr.write(`dsh-usage: 已写入 ${loaded.rows.length} 天 -> ${options.out}\n`);
  } else {
    process.stdout.write(body);
  }
  return 0;
}

/** 仅在直接执行时跑 main（被测试 import 时不执行）。 */
function isDirectInvocation() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
    return self === invoked;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dsh-usage: 意外错误 ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
