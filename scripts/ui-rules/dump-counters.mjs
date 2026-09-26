#!/usr/bin/env node
/**
 * 计数型判据的明细导出（目前只有 V1「新增边框」用得上）。
 *
 * 为什么需要它：V1 是 `tier: "info"` 的计数型提醒，`check-ui-rules.mjs` **只报总数、
 * 不逐行报**（设计如此：全库基线 800+ 处，逐行会把报告淹掉）。但要真去处理它时，
 * 「这 13 处到底在哪」必须能查出来 —— 这个脚本就干这件事。
 *
 * 口径与 check-ui-rules 完全一致：同一套 diff 作用域 + 同一套「只扫 `src/`」+ `ui-rule-ok` 豁免。
 * 刻意的差别只有一处：这里给 git 加了 `-c core.quotePath=false`。
 * scope.mjs 走默认 quotePath，git 会把非 ASCII 路径转义成 `"b/docs/\350\247\204..."`，
 * 而它的 unquote 用 JSON.parse 去解八进制转义（那不是合法 JSON 转义）会失败、只去掉引号，
 * 于是含中文的路径永远匹配不上真实绝对路径 —— **lint:ui 对这类文件是静默失效的**。
 * 当前 `src/` 下没有中文路径文件（lint:ui 只扫 src），所以还没表现出来；记在这里备查。
 *
 * 用法：
 *   node scripts/ui-rules/dump-counters.mjs [仓库根]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { allowAt } from "./rules.mjs";

const root = process.argv[2] ?? process.cwd();

function git(args) {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // 无 HEAD 的仓库 git diff 会非零退出，但 stdout 仍有内容
    return err && typeof err.stdout === "string" ? err.stdout : "";
  }
}

/** 解析 `@@ -a,b +c,d @@` → 新文件侧的行号集合 */
function collectFromDiff(text, into) {
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (cur && !into.has(cur)) into.set(cur, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !cur) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const set = into.get(cur);
    for (let i = 0; i < count; i++) set.add(start + i);
  }
  return into;
}

const scope = collectFromDiff(
  git(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "HEAD", "--"]),
  new Map(),
);
// 未跟踪的新文件整体都算新代码
for (const rel of git(["ls-files", "--others", "--exclude-standard"]).split("\n")) {
  const p = rel.trim();
  if (p) scope.set(p, "ALL");
}
for (const [k, v] of [...scope]) if (v !== "ALL" && v.size === 0) scope.delete(k);
// 与 check-ui-rules.mjs 一致：lint:ui 只 walk(src)（`design/` 设计稿与 `scripts/` 夹具都不在范围内）。
// 少了这一句会把稿子里的边框也算进来，报出跟门禁对不上的数字。
for (const k of [...scope.keys()]) if (!k.startsWith("src/")) scope.delete(k);

/** V1 的属性名口径（与 css-scan.mjs 的 V1 判定逐字对齐） */
const BORDER_PROP = /^(border|border-(top|bottom|left|right|inline|block|start|end))$/;

const rows = [];
for (const [rel, v] of scope) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(root, rel), "utf8").split(/\r?\n/);
  } catch {
    continue; // 已删除的文件
  }
  text.forEach((line, i) => {
    const lineNo = i + 1;
    if (v !== "ALL" && !v.has(lineNo)) return;
    const m = /^\s*([a-zA-Z-]+)\s*:\s*([^;]*);/.exec(line);
    if (!m) return;
    if (!BORDER_PROP.test(m[1].toLowerCase())) return;
    if (!/\bsolid\b|\b\d+px\b/.test(m[2])) return; // V1 只数 solid 或带 px 的
    if (allowAt(text, lineNo).state === "ok") return; // 与 U5space 同口径：豁免过的不计数
    rows.push(`${rel}:${lineNo}  ${m[1].toLowerCase()}: ${m[2].trim()}`);
  });
}

const css = rows.filter((r) => /\.css:/.test(r)).length;
console.log(`V1 计数明细：共 ${rows.length} 条（CSS ${css} / 其他 ${rows.length - css}）`);
for (const r of rows) console.log(`  ${r}`);
if (!rows.length) console.log("  （0 条 —— 新增边框已全部换掉或写了 ui-rule-ok 理由）");
