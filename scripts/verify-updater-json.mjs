#!/usr/bin/env node
/**
 * verify-updater-json.mjs
 * 发布前冒烟校验 updater manifest，防止坏产物被静默发布。
 *
 * 用法：
 *   node scripts/verify-updater-json.mjs <manifest-path>
 *   node scripts/verify-updater-json.mjs dist/updater.json
 *
 * 校验项（任一不满足即 exit 1，红灯拦在 Release 发布之前）：
 *   1. version 与 tauri.conf.json 一致
 *   2. notes 非空、不是已知兜底文案、且至少含一条 "- " 列表项
 *   3. pub_date 存在
 *   4. platforms 非空，且每个平台都有非空 signature 与 url
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function fail(msg) {
  console.error(`\x1b[31m[verify-updater-json ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  fail("用法: node scripts/verify-updater-json.mjs <manifest-path>");
}

const absPath = resolve(ROOT, manifestPath);
if (!existsSync(absPath)) {
  fail(`manifest 不存在: ${absPath}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(absPath, "utf-8"));
} catch (e) {
  fail(`manifest 不是合法 JSON: ${e.message}`);
}

// 期望版本：以 tauri.conf.json 为唯一版本源
const conf = JSON.parse(
  readFileSync(resolve(ROOT, "src-tauri", "tauri.conf.json"), "utf-8")
);
const expectedVersion = conf.version;

const problems = [];

// 1. 版本一致
if (manifest.version !== expectedVersion) {
  problems.push(
    `version 不匹配: manifest=${manifest.version}, tauri.conf.json=${expectedVersion}`
  );
}

// 2. notes 内容
const notes = (manifest.notes || "").trim();
const FALLBACK_TEXTS = ["常规构建发布", `PastePanda v${expectedVersion}`];
if (!notes) {
  problems.push("notes 为空");
} else if (FALLBACK_TEXTS.includes(notes)) {
  problems.push(`notes 是兜底文案"${notes}"（更新日志提取失败的产物）`);
} else if (!notes.split(/\r?\n/).some((l) => /^- /.test(l.trim()))) {
  problems.push('notes 中没有任何 "- " 更新条目，疑似提取失败');
}

// 3. pub_date
if (!manifest.pub_date) {
  problems.push("pub_date 缺失");
}

// 4. platforms
const platforms = manifest.platforms || {};
const platformKeys = Object.keys(platforms);
if (platformKeys.length === 0) {
  problems.push("platforms 为空（没有任何平台的安装包）");
}
for (const key of platformKeys) {
  const p = platforms[key];
  if (!p.signature || !p.signature.trim()) {
    problems.push(`platforms[${key}].signature 为空（更新将无法通过签名验证）`);
  }
  if (!p.url || !p.url.trim()) {
    problems.push(`platforms[${key}].url 为空`);
  }
}

if (problems.length > 0) {
  fail(`${manifestPath} 校验失败:\n  - ${problems.join("\n  - ")}`);
}

console.log(
  `[verify-updater-json OK] ${manifestPath}: v${manifest.version}, ` +
    `${platformKeys.length} 个平台, notes ${notes.length} 字符`
);
