#!/usr/bin/env node
/**
 * locale 文件一致性检查（CI 用）。
 *
 * 两个 locale 文件的键必须完全一致，且值不能是空字符串：缺键或空值在界面上
 * 表现为一块空白（宿主 locale 缺 key 时的兜底在 client.js 的 makeTranslator，
 * 这里从源头拦住，别让问题走到运行时）。
 *
 * 用法：node tools/check-locale.mjs
 */
import { readFileSync } from 'node:fs';

const FILES = ['locale/zh.json', 'locale/en.json'];

/** @param {string} file */
function load(file) {
  let text;
  try {
    text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  } catch (error) {
    throw new Error(`${file}: 无法读取（${error.code ?? error.message}）`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: 不是合法 JSON（${error.message}）`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: 顶层必须是对象`);
  }
  return value;
}

/** 把嵌套对象摊平成 a.b.c -> value，便于跨语言比较。 */
function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, out);
      continue;
    }
    out.set(path, child);
  }
  return out;
}

const problems = [];
const loaded = FILES.map((file) => ({ file, flat: flatten(load(file)) }));
const [base, ...rest] = loaded;

for (const { file, flat } of loaded) {
  for (const [key, value] of flat) {
    if (typeof value !== 'string') {
      problems.push(`${file}: ${key} 必须是字符串，实际是 ${typeof value}`);
      continue;
    }
    if (value.trim() === '') problems.push(`${file}: ${key} 是空字符串`);
  }
}

for (const { file, flat } of rest) {
  for (const key of base.flat.keys()) {
    if (!flat.has(key)) problems.push(`${file}: 缺少 ${base.file} 里的键 ${key}`);
  }
  for (const key of flat.keys()) {
    if (!base.flat.has(key)) problems.push(`${base.file}: 缺少 ${file} 里的键 ${key}`);
  }
}

if (problems.length > 0) {
  console.error('locale 检查失败：');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(`locale 检查通过：${FILES.join(' / ')}，各 ${base.flat.size} 个键`);
