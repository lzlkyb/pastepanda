#!/usr/bin/env node
/**
 * UI 规则校验 —— 把 `docs/PastePanda-UI规则.md` 接成「改完必须过的一道工序」。
 *
 * 为什么需要它
 * ------------
 * AGENTS.md 早就写了「改 UI 前读它，改完对它的自查清单」，但那是指针不是链路。
 * 2026-09-22 审远程电脑工作台时抓到的偏离（11px 灰字用在说明文字而非 meta、
 * `--section-bg` 与 `--app-bg` 差值过小导致材质分层失效、`--card-selected-bg/shadow`
 * 定义了却没用）**都不是「不知道规则」，是「改的时候没对着规则查」**。
 *
 * 所以这个脚本做两件事：
 *   ① 把文档里**可判定**的规则变成机器检查（可判定的定义：能对着代码一眼说出违反了没）；
 *   ② 把**不可判定**的那些在每次跑完时打出来，提醒人还有哪些要靠眼睛。
 *
 * 🔴 只查改动行（见 scope.mjs）。存量走 --all，只报告不拦——
 * 文档 §10 写得很清楚：不搞大扫除，碰到哪块改哪块。
 *
 * 用法
 * ----
 *   node scripts/check-ui-rules.mjs              查本次改动行（默认）
 *   node scripts/check-ui-rules.mjs --staged     只查暂存的行（pre-commit 用）
 *   node scripts/check-ui-rules.mjs --all        全库基线报告（不拦，除非加 --strict）
 *   node scripts/check-ui-rules.mjs --strict     有 block 级问题就退出 1
 *   node scripts/check-ui-rules.mjs --no-warn    只报 block 级，忽略 warn
 *   node scripts/check-ui-rules.mjs --quiet      只输出结论
 *   node scripts/check-ui-rules.mjs --list-rules 打印规则表
 *   node scripts/check-ui-rules.mjs <文件...>    只查给定文件（全部行）
 *
 * 豁免：在违反处（本行或上一行）写 `/* ui-rule-ok: 理由 *​/`。
 * **必须带理由**——理由短于 4 个字符不算数，直接报出来。理由是给下一个人看的。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RULES, ALLOW_MARK, MANUAL_CHECKLIST, allowAt } from "./ui-rules/rules.mjs";
import { collectScope, normalizeScope, inScope, fileInScope } from "./ui-rules/scope.mjs";
import { scanCss } from "./ui-rules/css-scan.mjs";
import { scanTs } from "./ui-rules/ts-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const fileArgs = argv.filter((a) => !a.startsWith("--"));
const QUIET = flags.has("--quiet");
const STRICT = flags.has("--strict");
const NO_WARN = flags.has("--no-warn");
const MODE = flags.has("--all") ? "all" : flags.has("--staged") ? "staged" : "diff";
const SKIP_FILES = /(\.test\.|\.spec\.|__tests__|__mocks__|\.d\.ts$)/;

if (flags.has("--list-rules")) {
  for (const [id, r] of Object.entries(RULES)) {
    console.log(`${id.padEnd(9)} [${r.tier}]  ${r.title}`);
    console.log(`          ${r.why}`);
  }
  process.exit(0);
}

/** 收集待扫文件 */
function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      walk(p, acc);
    } else if (/\.(css|ts|tsx)$/.test(ent.name) && !SKIP_FILES.test(ent.name)) {
      acc.push(p);
    }
  }
  return acc;
}

let targets;
let scope = null;
if (fileArgs.length) {
  targets = fileArgs.map((f) => path.resolve(ROOT, f)).filter((f) => fs.existsSync(f));
} else {
  const raw = collectScope({ root: ROOT, mode: MODE });
  scope = normalizeScope(ROOT, raw);
  targets = walk(SRC).filter((f) => fileInScope(scope, f));
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

const findings = [];
const stats = { border: 0, inlineStyle: 0, spacingOff: 0 };
let scannedFiles = 0;
let scannedLines = 0;

for (const file of targets.sort()) {
  const ext = path.extname(file);
  if (ext === ".png" || ext === ".svg") continue;
  const abs = path.resolve(file);
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);

  const record = scope?.lines.get(abs);
  const inScopeLine = (line) => inScope(scope, abs, line);
  if (record !== undefined && record !== "ALL") scannedLines += record.size;
  else scannedLines += lines.length;

  const hasAllow = (() => {
    const cache = new Map();
    return (line) => {
      if (!cache.has(line)) cache.set(line, allowAt(lines, line));
      return cache.get(line).state === "ok";
    };
  })();

  const bareAllows = [];
  if (ext === ".css") {
    let out;
    try {
      out = scanCss(text, inScopeLine, hasAllow);
    } catch (err) {
      // 🔴 不能只是打个警告就 continue：那会让整份文件（往往几百行、上百个颜色）
      // 静默退出检查。解析失败本身就是一个必须处理的问题，按 finding 报。
      scannedFiles++;
      const line = typeof err.line === "number" ? err.line : 1;
      const reason = err.reason || err.message || "解析失败";
      findings.push({
        rule: "SYNTAX",
        file: abs,
        line,
        snippet: `${reason}（${line}:${err.column ?? "?"}）—— 本文件其余规则未被检查`,
      });
      continue;
    }
    scannedFiles++;
    findings.push(...out.findings.map((f) => ({ ...f, file: abs })));
    for (const k of Object.keys(stats)) if (out.stats[k]) stats[k] += out.stats[k];
  } else {
    const out = scanTs(abs, text, inScopeLine, hasAllow, rel(abs));
    scannedFiles++;
    findings.push(...out.findings.map((f) => ({ ...f, file: abs })));
    stats.inlineStyle += out.stats.inlineStyle;
  }

  // 带了标记但没写理由的，单独报——不能让它变成万能洗白开关
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(ALLOW_MARK)) continue;
    if (!inScopeLine(i + 1)) continue;
    if (allowAt(lines, i + 1).state === "bare") bareAllows.push(i + 1);
  }
  if (bareAllows.length) {
    findings.push({
      rule: "ALLOW",
      file: abs,
      line: bareAllows[0],
      snippet: `第 ${bareAllows.join("、")} 行的 ${ALLOW_MARK} 没写理由`,
    });
  }
}

// ── 报告 ────────────────────────────────────────────────────
// 去重：`transition: a 100ms, b 100ms` 这种会在同一行命中多次同一判据，
// 印三遍同一句话只会让人不再读输出。
const deduped = new Map();
for (const f of findings) {
  const key = `${f.rule}|${f.file}|${f.line}|${f.snippet}`;
  if (!deduped.has(key)) deduped.set(key, f);
}
const grouped = new Map();
for (const f of deduped.values()) {
  const tier = f.rule === "ALLOW" ? "block" : RULES[f.rule]?.tier ?? "warn";
  if (NO_WARN && tier !== "block") continue;
  if (!grouped.has(f.rule)) grouped.set(f.rule, []);
  grouped.get(f.rule).push(f);
}

const scopeLabel =
  MODE === "all" ? "全库基线" : MODE === "staged" ? "暂存区" : "本次改动";
if (!QUIET) {
  console.log(
    `UI 规则校验（${scopeLabel}）：扫了 ${scannedFiles} 个文件 / ${MODE === "all" ? scannedLines : scannedLines} 行` +
      (MODE === "all" ? "（存量不拦，只作基线）" : ""),
  );
}

const blockCount = [...grouped.entries()].reduce(
  (n, [id, list]) => n + ((RULES[id]?.tier ?? "block") === "block" ? list.length : 0),
  0,
);

if (!grouped.size && !QUIET) {
  // 🔴 从 RULES 现算，不写死一份清单——手写的那份在加了 U2spring / V8 之后就成了谎话，
  //    而「报告说查过了、其实没这条判据」正是这个工具最该防的故障。
  const ids = Object.entries(RULES)
    .filter(([, r]) => r.tier !== "info")
    .map(([id]) => id);
  console.log(`  ✅ 改动行没碰到 ${ids.join("/")} 的判定线`);
}

const byId = [...grouped.entries()].sort((a, b) => {
  const t = (id) => (RULES[id]?.tier === "block" ? 0 : 1);
  return t(a[0]) - t(b[0]) || b[1].length - a[1].length;
});

for (const [id, list] of byId) {
  const meta = RULES[id] || {
    tier: "block",
    title: `${ALLOW_MARK} 标记缺理由`,
    why: `写了 ${ALLOW_MARK} 但没说为什么。豁免是留给「说不清就违规」的，理由必须留给下一个人看。`,
    fix: `补成 ${ALLOW_MARK}: <为什么这里必须这样>`,
  };
  const tag = meta.tier === "block" ? "必须处理" : "建议";
  console.log("");
  console.log(`── ${id} · ${meta.title} × ${list.length}  [${tag}] ${"─".repeat(Math.max(0, 18 - id.length))}`);
  if (!QUIET) {
    console.log(`   ${meta.why}`);
    console.log(`   → ${meta.fix}`);
  }
  const shown = list.slice(0, 25);
  for (const f of shown) console.log(`     ${rel(f.file)}:${f.line}  ${f.snippet}`);
  if (list.length > shown.length) console.log(`     … 另有 ${list.length - shown.length} 处`);
}

// ── 计数型提醒（不逐行报的） ────────────────────────────────
const counters = [];
if (stats.border) counters.push(`V1 新增边框 ${stats.border} 处 — 层级手段优先 ①间距 → ②背景色 → ③边框（改前 803 处 1px solid）`);
if (stats.inlineStyle) counters.push(`U8 内联 style ${stats.inlineStyle} 处 — 它拿不到伪类/媒体查询/主题覆盖`);
if (stats.spacingOff) counters.push(`U5 间距不在表里 ${stats.spacingOff} 处`);
if (counters.length && !QUIET) {
  console.log("");
  console.log("── 计数型提醒（不逐行报） ──");
  for (const c of counters) console.log(`   ${c}`);
}

// ── 机器查不到的，交回给人 ─────────────────────────────────
if (!QUIET && MODE === "all") {
  console.log("");
  console.log("── 机器判不了的，逐条对人看（docs/PastePanda-UI规则.md §9） ──");
  for (const [id, q] of MANUAL_CHECKLIST) console.log(`   ${id.padEnd(4)} ${q}`);
}

let exitCode = 0;
if (blockCount) {
  if (MODE === "all" && !STRICT) {
    if (!QUIET) console.log(`\n   ℹ️ 全库基线：block 级 ${blockCount} 处（存量不拦。要当门禁用加 --strict）`);
  } else {
    console.log(`\n❌ ${blockCount} 处必须处理（block 级）。`);
    console.log(`   确是「间距和背景色都不行」这类情况，就在那一行加注释：${ALLOW_MARK}: <理由>`);
    exitCode = 1;
  }
} else if (!QUIET) {
  console.log("\n✅ block 级 0 处。");
}

process.exit(exitCode);
