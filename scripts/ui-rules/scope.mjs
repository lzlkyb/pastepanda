/**
 * 作用域：算出「这次到底动了哪些文件的哪些行」。
 *
 * 🔴 这是整套校验能不能活下来的关键。
 *
 * 文档 §10 写的是「本文只约束新写的代码，以及你本来就在改的那一块」。
 * 但如果校验器扫整个文件，那改 `RemoteComputerA2.module.css` 里一个字号，
 * 会连带报出这个文件里 260 处存量硬编码颜色——**没人会去修，于是所有人开始加
 * `--no-verify`，校验等于不存在。**
 *
 * 所以默认模式是 diff 作用域：只查本次改动新增/修改的行。
 * 存量走 `--all`（只作基线报告，默认不拦）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // git diff 在「无 HEAD（全新仓库）」时会非零退出，但 stdout 仍有内容
    return err && typeof err.stdout === "string" ? err.stdout : "";
  }
}

/** git 的路径在 core.quotePath 下可能被引号包住并转义 */
function unquote(p) {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p);
  } catch {
    return p.replace(/^"|"$/g, "");
  }
}

/** 解析 `@@ -a,b +c,d @@` → 新文件侧的行号集合 */
function collectFromDiff(text, into) {
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4).trim());
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

/**
 * @param {{root:string, mode:"diff"|"staged"|"all"}} opts
 * @returns {null | Map<string, Set<number>|"ALL">} null = 不过滤（全量）
 *          文件名是仓库相对路径（正斜杠）
 */
export function collectScope({ root, mode }) {
  if (mode === "all") return null;

  // --no-renames：改名按「删+增」处理，改名后的整份文件都算新代码（这本就是我们要的）
  const base = ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames"];
  const text = git(root, [...base, mode === "staged" ? "--cached" : "HEAD", "--"]);

  const map = collectFromDiff(text, new Map());

  // 未跟踪的新文件整体都是新代码。只在 diff 模式下加——
  // staged 模式（pre-commit）下它们是「还没 git add」的文件，不该被检查。
  if (mode === "diff") {
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
    for (const rel of untracked.split("\n")) {
      const p = rel.trim();
      if (p) map.set(p, "ALL");
    }
  }

  // 删掉空集合（纯删除的文件）
  for (const [k, v] of [...map]) if (v !== "ALL" && v.size === 0) map.delete(k);

  return map;
}

/**
 * 把仓库相对路径的作用域表转成绝对路径，并判断某个文件是否整体在范围内。
 * @returns {null | {files:Set<string>, lines:Map<string,Set<number>|"ALL">}}
 */
export function normalizeScope(root, scope) {
  if (scope === null) return null;
  const lines = new Map();
  for (const [rel, v] of scope) lines.set(path.resolve(root, rel), v);
  return { files: new Set(lines.keys()), lines };
}

/** 给定绝对路径与行号，判断是否要检查这一行 */
export function inScope(scope, absPath, line) {
  if (scope === null) return true;
  const v = scope.lines.get(absPath);
  if (v === undefined) return false;
  if (v === "ALL") return true;
  return v.has(line);
}

/** 该文件是否在作用域里（用于跳过整文件解析） */
export function fileInScope(scope, absPath) {
  return scope === null || scope.lines.has(absPath);
}

/** 读文件行数组，供豁免注释查找用 */
export function readLines(absPath) {
  return fs.readFileSync(absPath, "utf8").split(/\r?\n/);
}
