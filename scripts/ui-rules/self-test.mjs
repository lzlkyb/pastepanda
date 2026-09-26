#!/usr/bin/env node
/**
 * 校验器自己的守卫测试。
 *
 * 🔴 为什么必须有：**校验器静默失效比没有校验器更糟。**
 * 一个把结论印成「✅ 0 处」的坏校验器，会让人误以为规则已经守住了——
 * 这和 `cargo clippy` 结果缓存骗人是同一类故障（见 MEMORY-env.md 判据 1）。
 *
 * 断言四件事（缺一个都算失败）：
 *   1. 违规样本**全部命中**——新加的判据没接上扫描器会被立刻抓出来；
 *   2. 合规样本**零命中**——误报一次，人就再也不看输出了；
 *   3. 豁免路径生效——带理由的 `ui-rule-ok` 确实压住了那一条；
 *   4. 计数型提醒（V1 边框）真的在数。
 *
 * 用法：node scripts/ui-rules/self-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanCss } from "./css-scan.mjs";
import { scanTs } from "./ts-scan.mjs";
import { allowAt } from "./rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "__fixtures__");

const all = () => true;
const read = (n) => fs.readFileSync(path.join(FIX, n), "utf8");

/**
 * 🔴 豁免通道必须走真实现（allowAt），不能在测试里传 `() => false`——
 * 否则「豁免生效」这件事根本没被测到，而它恰恰是最容易被写坏的一环
 * （一条 `ui-rule-ok` 就洗白整个文件，或者反过来带了理由也不生效）。
 */
const makeAllow = (text) => {
  const lines = text.split(/\r?\n/);
  return (line) => allowAt(lines, line).state === "ok";
};

const failures = [];
const notes = [];

function expectSet(label, got, want) {
  const missing = [...want].filter((r) => !got.has(r));
  const extra = [...got].filter((r) => !want.has(r));
  if (missing.length) failures.push(`${label}：漏报 ${missing.join("、")}`);
  if (extra.length) failures.push(`${label}：误报 ${extra.join("、")}`);
  if (!missing.length && !extra.length) notes.push(`${label}：命中 ${want.size} 条判据，与预期一致`);
}

// ── CSS ───────────────────────────────────────────────────────
const cssBadText = read("violations.css");
const cssBad = scanCss(cssBadText, all, makeAllow(cssBadText));
const cssBadRules = new Set(cssBad.findings.map((f) => f.rule));
expectSet(
  "violations.css",
  cssBadRules,
  new Set([
    "U2",
    "U2ease",
    "U2spring",
    "U2token",
    "U5radius",
    "U5font",
    "U5space",
    "U6",
    "V2",
    "V3rgb",
    "V3",
    "V6",
    "V8leftbar",
    "V8font",
  ]),
);

// 豁免：带理由的那一条必须被压住（U5radius 全文件只应剩 1 处 = .k-u5-a）
const radiusHits = cssBad.findings.filter((f) => f.rule === "U5radius");
if (radiusHits.length !== 1) {
  failures.push(`豁免失效：U5radius 应为 1 处（.k-u5-a），实际 ${radiusHits.length} 处`);
} else {
  notes.push("豁免生效：带理由的 ui-rule-ok 压住了 .k-allow");
}

// 计数型：V1 边框。夹具里有 3 条会命中的 border——
//   .k-v1（border-top）/ .k-v1-allow（border-top，带理由豁免）/ .k-v8-leftbar（border-left）；
//   .k-v8-leftbar-split 写的是 border-left-width/color，V1 的属性名正则不收。
// 所以期望 2 处 = 「计数真的在数」+「计数认 ui-rule-ok」（后者 2026-09-26 之前是坏的：
// 直接 ++，写了理由也照样计数，与文档「说不出理由 → 违反」的判定句对不上）。
if (cssBad.stats.border !== 2) {
  failures.push(`V1 计数错误：应为 2 处（3 条 border 减 1 条豁免），实际 ${cssBad.stats.border} 处`);
} else {
  notes.push("V1 边框计数生效（3 条中豁免 1 条 → 计 2 处，且豁免确实压住了计数）");
}

const cssOkText = read("clean.css");
const cssOk = scanCss(cssOkText, all, makeAllow(cssOkText));
if (cssOk.findings.length) {
  failures.push(
    `clean.css 误报 ${cssOk.findings.length} 处：` +
      cssOk.findings.map((f) => `${f.rule}@L${f.line}`).join("、"),
  );
} else {
  notes.push("clean.css：零误报");
}

// ── TS / TSX ──────────────────────────────────────────────────
const tsBadText = read("violations.tsx");
const tsBad = scanTs(
  path.join(FIX, "violations.tsx"),
  tsBadText,
  all,
  makeAllow(tsBadText),
  "scripts/ui-rules/__fixtures__/violations.tsx",
);
expectSet(
  "violations.tsx",
  new Set(tsBad.findings.map((f) => f.rule)),
  new Set(["U8", "U5font", "U5radius", "U5space", "U2", "U3_5", "L2", "L3", "V3", "U6"]),
);

const inlineHits = tsBad.findings.filter((f) => f.rule === "U8").length;
if (inlineHits !== 3) failures.push(`U8 计数错误：应为 3 处内联 style，实际 ${inlineHits} 处`);
else notes.push("U8 内联 style 计数生效（3 处）");

const tsOkText = read("clean.tsx");
const tsOk = scanTs(
  path.join(FIX, "clean.tsx"),
  tsOkText,
  all,
  makeAllow(tsOkText),
  "scripts/ui-rules/__fixtures__/clean.tsx",
);
if (tsOk.findings.length) {
  failures.push(
    `clean.tsx 误报 ${tsOk.findings.length} 处：` +
      tsOk.findings.map((f) => `${f.rule}@L${f.line} ${f.snippet.slice(0, 50)}`).join(" | "),
  );
} else {
  notes.push("clean.tsx：零误报");
}

// ── 结论 ──────────────────────────────────────────────────────
for (const n of notes) console.log(`  ✓ ${n}`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n❌ 守卫测试失败 ${failures.length} 项——校验器本身不可信，先修它。`);
  process.exit(1);
}
console.log("\n✅ 校验器守卫测试全过（漏报 / 误报 / 豁免 / 计数 四项）。");
