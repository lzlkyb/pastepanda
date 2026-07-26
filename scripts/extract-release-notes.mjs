#!/usr/bin/env node
/**
 * extract-release-notes.mjs
 * 从 CHANGELOG.md 提取指定版本的更新日志段落，供发版 CI 使用。
 *
 * 用法：
 *   node scripts/extract-release-notes.mjs [version]
 *
 * 版本来源：CLI 参数优先；否则读 GITHUB_REF_NAME（tag 名，自动去 v 前缀）。
 *
 * 输出（写入 $GITHUB_OUTPUT，本地无该环境变量时打印到 stdout）：
 *   release_body   — 版本段落原文（含 ### 分类标题），用于 GitHub Release body
 *   updater_notes  — 段落内所有 "- " 条目（换行拼接），用于 updater.json notes
 *
 * 失败即 exit 1（发版红灯，不再静默回退"常规构建发布"）：
 *   - CHANGELOG.md 不存在
 *   - 找不到该版本的段落（先打 tag 后补日志会被拦下）
 *   - 段落内没有任何 "- " 条目
 *
 * 设计说明：用 Node 替代 release.yml 里的内联 PowerShell 正则——
 * Node 按 UTF-8 读取、以 /\r?\n/ 分行，天然免疫 Windows runner
 * autocrlf 检出产生的 CRLF 与编码问题（v5.1.2/v5.2.0 踩过坑）。
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGELOG_PATH = resolve(ROOT, "CHANGELOG.md");

function fail(msg) {
  console.error(`\x1b[31m[extract-release-notes ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}

// ─── 版本号 ────────────────────────────────────────────

const argVersion = process.argv[2];
const refName = process.env.GITHUB_REF_NAME || "";
const rawVersion = argVersion || refName;
const version = rawVersion.replace(/^v/, "").trim();

if (!version) {
  fail("未指定版本：传 CLI 参数或在 CI 中提供 GITHUB_REF_NAME");
}

// ─── 读取与分行（CRLF/LF 均可）────────────────────────

if (!existsSync(CHANGELOG_PATH)) {
  fail(`CHANGELOG.md 不存在: ${CHANGELOG_PATH}`);
}

const content = readFileSync(CHANGELOG_PATH, "utf-8");
const lines = content.split(/\r?\n/);

// ─── 定位版本段落 ──────────────────────────────────────

const headingRe = new RegExp(`^##\\s+\\[${version.replace(/\./g, "\\.")}\\]`);
const startIdx = lines.findIndex((l) => headingRe.test(l.trim()));

if (startIdx === -1) {
  fail(
    `CHANGELOG.md 中未找到版本 ${version} 的段落（## [${version}] ...）。` +
      "请确认更新日志已写入后再打 tag 发版。"
  );
}

// 收集到下一个 "## [" 或文件末尾
const sectionLines = [];
for (let i = startIdx + 1; i < lines.length; i++) {
  if (/^##\s+\[/.test(lines[i].trim())) break;
  sectionLines.push(lines[i]);
}

const releaseBody = sectionLines.join("\n").trim();

if (!releaseBody) {
  fail(`版本 ${version} 的段落为空`);
}

// ─── 提取列表项（updater notes）───────────────────────

const items = [];
for (const line of sectionLines) {
  const m = line.trim().match(/^- (.+)/);
  if (m) items.push(`- ${m[1]}`);
}

if (items.length === 0) {
  fail(`版本 ${version} 的段落内没有任何 "- " 条目，无法生成更新说明`);
}

const updaterNotes = items.join("\n");

// ─── 输出 ──────────────────────────────────────────────

const DELIM = "CHANGELOG_EOF";
const outputFile = process.env.GITHUB_OUTPUT;

if (outputFile) {
  appendFileSync(
    outputFile,
    `release_body<<${DELIM}\n${releaseBody}\n${DELIM}\n` +
      `updater_notes<<${DELIM}\n${updaterNotes}\n${DELIM}\n`,
    "utf-8"
  );
  console.log(`[extract-release-notes OK] v${version}：${items.length} 条更新项已写入 GITHUB_OUTPUT`);
} else {
  // 本地调试：打印到 stdout
  console.log(`[extract-release-notes OK] v${version}：${items.length} 条更新项`);
  console.log("--- release_body ---");
  console.log(releaseBody);
  console.log("--- updater_notes ---");
  console.log(updaterNotes);
}
