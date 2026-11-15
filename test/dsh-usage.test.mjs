import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DAILY_FIELDS, DataError, csvEscape, loadDailyRows, parseArgs, render, toCsv, toJsonl, UsageError } from '../bin/dsh-usage.mjs';

const BIN = fileURLToPath(new URL('../bin/dsh-usage.mjs', import.meta.url));

/** 造一份最小可用的 single 布局快照：只填部分字段，留给 schema 归一化补零。 */
function makeSnapshot(days) {
  return {
    unit: { name: 'plugin_analytics_test', version: 1 },
    global: { installId: 'ins_test', cursors: { s1: 3 } },
    tables: {
      meta: {},
      daily: Object.fromEntries(days.map((day) => [day, { day, events: 10, toolCalls: 4, toolErrors: 1, tokensIn: 100, tokensOut: 20 }])),
      tool_daily: {},
      cap_daily: {},
      sessions: {},
    },
  };
}

/** 建一个带快照的临时目录，返回 { dir, file, cleanup }。 */
function makeTempSnapshot(days) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-usage-test-'));
  const file = path.join(dir, 'plugin_analytics_test.json');
  writeFileSync(file, JSON.stringify(makeSnapshot(days)), 'utf8');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────

test('parseArgs：合法参数与缺省值', () => {
  assert.deepEqual(parseArgs(['jsonl']), { format: 'jsonl', from: undefined, to: undefined, out: undefined, profile: undefined, file: undefined, home: undefined, help: false });
  const full = parseArgs(['csv', '--from', '2026-11-01', '--to', '2026-11-03', '--out', 'd.csv', '--profile', 'desktop', '--file', 'a.json', '--home', 'F:/x']);
  assert.deepEqual(full, { format: 'csv', from: '2026-11-01', to: '2026-11-03', out: 'd.csv', profile: 'desktop', file: 'a.json', home: 'F:/x', help: false });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['JSONL']).format, 'jsonl', '格式大小写不敏感');
});

test('parseArgs：非法输入抛 UsageError', () => {
  for (const argv of [
    [],
    ['jsonl', 'csv'],
    ['xml'],
    ['jsonl', '--from', '20261101'],
    ['jsonl', '--from', '2026-11-03', '--to', '2026-11-01'],
    ['jsonl', '--wat'],
    ['jsonl', '--out'],
  ]) {
    assert.throws(() => parseArgs(argv), UsageError, `argv=${JSON.stringify(argv)}`);
  }
});

// ── 渲染 ──────────────────────────────────────────────────────────────────────

test('toJsonl：每日一行、字段齐全、行数等于天数', () => {
  const rows = [
    { day: '2026-11-01', events: 1, toolCalls: 2, toolErrors: 0, steps: 0, turns: 0, sessions: 0, tokensIn: 5, tokensOut: 1, ms: 0, msSamples: 0, maxMs: 0, panels: 0, commands: 0, mcp: 0, skills: 0, dropped: 0 },
    { day: '2026-11-02', events: 3, toolCalls: 0, toolErrors: 0, steps: 0, turns: 0, sessions: 1, tokensIn: 0, tokensOut: 0, ms: 0, msSamples: 0, maxMs: 0, panels: 0, commands: 0, mcp: 0, skills: 0, dropped: 0 },
  ];
  const text = toJsonl(rows);
  const lines = text.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 2);
  assert.ok(text.endsWith('\n'), 'JSONL 以换行结尾');
  const first = JSON.parse(lines[0]);
  assert.equal(first.kind, 'daily');
  assert.equal(first.day, '2026-11-01');
  for (const field of DAILY_FIELDS) assert.ok(field in first, `缺字段 ${field}`);
  assert.equal(JSON.parse(lines[1]).day, '2026-11-02');
  assert.equal(toJsonl([]), '', '空数据输出空串');
});

test('toCsv：表头行 + 每日一行，含引号转义', () => {
  const header = DAILY_FIELDS.join(',');
  const text = toCsv([{ ...Object.fromEntries(DAILY_FIELDS.map((field) => [field, 0])), day: '2026-11-01' }]);
  const lines = text.split('\n').filter((line) => line !== '');
  assert.equal(lines[0], header);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].startsWith('2026-11-01,'), true);
  assert.equal(csvEscape('a,"b"'), '"a,""b"""');
  assert.equal(csvEscape(42), '42');
  // render 双格式入口：csv 与 jsonl 同源
  const rows = [];
  assert.equal(render('csv', rows), `${header}\n`);
});

// ── 数据加载 ──────────────────────────────────────────────────────────────────

test('loadDailyRows：快照按日期升序、schema 缺字段补零', () => {
  const { file, cleanup } = makeTempSnapshot(['2026-11-02', '2026-11-01', '2026-11-03']);
  try {
    const { rows, store } = loadDailyRows({ file });
    assert.deepEqual(rows.map((row) => row.day), ['2026-11-01', '2026-11-02', '2026-11-03']);
    for (const row of rows) {
      for (const field of DAILY_FIELDS) assert.equal(typeof row[field], field === 'day' ? 'string' : 'number', `字段 ${field} 类型`);
    }
    assert.equal(rows[0].ms, 0, '快照未给的 ms 字段应补 0');
    assert.equal(rows[0].tokensIn, 100);
    assert.equal(store.meta.installId, 'ins_test', 'meta 经 schema 归一化读回');
  } finally {
    cleanup();
  }
});

test('loadDailyRows：--from/--to 闭区间过滤', () => {
  const { file, cleanup } = makeTempSnapshot(['2026-11-01', '2026-11-02', '2026-11-03']);
  try {
    assert.deepEqual(loadDailyRows({ file, from: '2026-11-02' }).rows.map((row) => row.day), ['2026-11-02', '2026-11-03']);
    assert.deepEqual(loadDailyRows({ file, to: '2026-11-02' }).rows.map((row) => row.day), ['2026-11-01', '2026-11-02']);
    assert.deepEqual(loadDailyRows({ file, from: '2026-11-02', to: '2026-11-02' }).rows.map((row) => row.day), ['2026-11-02'], 'from==to 只剩一天');
    assert.equal(loadDailyRows({ file, from: '2026-11-04' }).rows.length, 0, '区间外为空');
  } finally {
    cleanup();
  }
});

test('loadDailyRows：数据文件缺失抛 DataError', () => {
  assert.throws(() => loadDailyRows({ file: path.join(tmpdir(), 'dsh-usage-no-such-file.json') }), (error) => error instanceof DataError);
});

// ── 端到端（子进程跑 bin） ─────────────────────────────────────────────────────

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

test('端到端：jsonl 输出到 stdout，行数与字段正确', () => {
  const { file, cleanup } = makeTempSnapshot(['2026-11-01', '2026-11-02']);
  try {
    const result = runCli(['jsonl', '--file', file]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2);
    const row = JSON.parse(lines[0]);
    assert.equal(row.kind, 'daily');
    assert.equal(row.day, '2026-11-01');
    assert.equal(row.toolCalls, 4);
    assert.equal(row.tokensIn, 100);
  } finally {
    cleanup();
  }
});

test('端到端：csv 输出表头 + 数据行；--out 落盘一致', () => {
  const { file, dir, cleanup } = makeTempSnapshot(['2026-11-01', '2026-11-02', '2026-11-03']);
  try {
    const stdout = runCli(['csv', '--file', file, '--from', '2026-11-02']);
    assert.equal(stdout.status, 0, `stderr: ${stdout.stderr}`);
    const lines = stdout.stdout.split('\n').filter((line) => line !== '');
    assert.equal(lines[0], DAILY_FIELDS.join(','), '首行表头');
    assert.equal(lines.length, 3, '表头 + 2 行数据（过滤后）');
    assert.equal(lines[1].split(',')[0], '2026-11-02');

    const out = path.join(dir, 'export.jsonl');
    const written = runCli(['jsonl', '--file', file, '--out', out]);
    assert.equal(written.status, 0);
    assert.ok(existsSync(out));
    assert.ok(written.stderr.includes('3 天'), '落盘提示写入天数');
    const fileLines = readFileSync(out, 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(fileLines.length, 3);
  } finally {
    cleanup();
  }
});

test('端到端：非法格式退出码 2，数据文件缺失退出码 1', () => {
  const bad = runCli(['xml']);
  assert.equal(bad.status, 2, '用法错误应退出 2');
  assert.ok(bad.stderr.includes('未知格式'));
  assert.ok(bad.stderr.includes('用法'), 'stderr 附带 usage');

  const missing = runCli(['jsonl', '--file', path.join(tmpdir(), 'dsh-usage-definitely-missing.json')]);
  assert.equal(missing.status, 1, '数据缺失应退出 1');
  assert.ok(missing.stderr.includes('数据文件不存在'));
});
