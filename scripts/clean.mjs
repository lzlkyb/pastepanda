#!/usr/bin/env node
/**
 * 工作区分级清理（2026-10-03 方案共识：业界也没有能兼顾增量编译的 target GC，
 * 官方 1.88 只稳定了「下载缓存」回收，target 产物 GC 仍是 nightly -Zgc）。
 *
 * 两档，删与不删的边界是「丢了要不要重编/重做」：
 * - 安全档（默认）：一次性探针输出、旧配置备份、装机残留 —— 只动 mtime
 *   超过 TTL（默认 3 天）的文件，避免误杀其它在途会话正在引用的现场。
 * - 缓存档（--deep）：promo 工具缓存目录；cargo 的 target/target-android 只打印
 *   `cargo clean` 指引不代删（全树作废 10–20 分钟起步，必须人拍板）。
 *
 * 用法：
 *   npm run clean                 # dry-run，只列清单和体积
 *   npm run clean -- --yes        # 执行安全档删除
 *   npm run clean:deep -- --yes   # 安全档 + promo 缓存目录
 */
import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TTL_DEFAULT_DAYS = 3;
const CONFIG_BACKUP_KEEP = 3;

/** 安全档：根目录一次性残留 */
const ROOT_FILES = ["new-installed.apk", "rd_files.json"];
/** 安全档：.cache 顶层这些后缀才碰（子目录是在途现场，默认不动） */
const CACHE_FILE_EXT = [".log", ".jsonl", ".png", ".jpg", ".exe", ".pdb"];
/** 缓存档：可再生的 promo/npm 工具缓存目录 */
const DEEP_DIRS = [
  ".cache/npm-promo",
  ".cache/promo-tools",
  ".cache/hyperframes-source",
  ".cache/promo-python",
];
/** 缓存档：只给指引、永不代删 */
const CARGO_DIRS = ["src-tauri/target", "src-tauri/target-android"];

function fmtSize(bytes) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)}G`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)}M`;
  if (bytes >= 1 << 10) return `${(bytes / 1024).toFixed(0)}K`;
  return `${bytes}B`;
}

/** 目录递归体积；跳过 node_modules 之外的软链防环，代价是可能慢——只在 dry-run 展示用 */
function dirSize(path) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += statSync(p).size;
      } catch {}
    }
  }
  return total;
}

/**
 * 计算安全档候选（纯计划，不删除，方便单测）：
 * @param {{root?: string, now?: number, ttlDays?: number, keepBackups?: number}} opts
 */
export function planSafe(opts = {}) {
  const root = opts.root ?? ROOT;
  const now = opts.now ?? Date.now();
  const ttlMs = (opts.ttlDays ?? TTL_DEFAULT_DAYS) * 86400_000;
  const keep = opts.keepBackups ?? CONFIG_BACKUP_KEEP;
  const files = [];
  const stale = (p) => {
    try {
      return now - statSync(p).mtimeMs > ttlMs;
    } catch {
      return false;
    }
  };

  for (const name of ROOT_FILES) {
    const p = join(root, name);
    if (existsSync(p)) files.push({ path: p, size: statSync(p).size, why: "装机/探针残留" });
  }
  // *.pppart：崩溃导出的 0 字节半成品（gitignore 同款后缀约定）
  for (const e of safeReadDir(root)) {
    if (e.isFile() && e.name.endsWith(".pppart")) {
      const p = join(root, e.name);
      files.push({ path: p, size: statSync(p).size, why: "导出中断残留" });
    }
  }
  if (existsSync(join(root, "config_backups"))) {
    const backups = safeReadDir(join(root, "config_backups"))
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => ({ name: e.name, p: join(root, "config_backups", e.name) }))
      .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs);
    for (const b of backups.slice(keep)) {
      files.push({ path: b.p, size: statSync(b.p).size, why: `配置备份只留最近 ${keep} 份` });
    }
  }
  if (existsSync(join(root, ".cache"))) {
    for (const e of safeReadDir(join(root, ".cache"))) {
      if (!e.isFile()) continue;
      if (!CACHE_FILE_EXT.some((x) => e.name.toLowerCase().endsWith(x))) continue;
      const p = join(root, ".cache", e.name);
      // 在途会话的护栏：最近 TTL 内被写过的一律不碰
      if (!stale(p)) continue;
      files.push({ path: p, size: statSync(p).size, why: `.cache 顶层探针输出，超 ${TTL_DEFAULT_DAYS} 天` });
    }
  }
  return files;
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  const deep = args.includes("--deep");
  const yes = args.includes("--yes");

  const safe = planSafe();
  let bytes = 0;
  console.log(`\n【安全档】${yes ? "删除" : "dry-run 预览"}（${safe.length} 项）`);
  for (const f of safe) {
    bytes += f.size;
    console.log(`  ${fmtSize(f.size).padStart(6)}  ${f.path.slice(ROOT.length + 1)}  (${f.why})`);
  }

  const deepDirs = DEEP_DIRS.filter((d) => existsSync(join(ROOT, d)));
  if (deep) {
    console.log(`\n【缓存档】--deep 会整目录删除（可再生，但下次要重装/重下载）：`);
    for (const d of deepDirs) {
      console.log(`  ${fmtSize(dirSize(join(ROOT, d))).padStart(6)}  ${d}`);
    }
  }
  console.log(`\ncargo 编译缓存（永不代删，全树作废=下次全量重编 10–20 分钟起）：`);
  for (const d of CARGO_DIRS) {
    if (existsSync(join(ROOT, d))) console.log(`  ${d} → 拍板后自己跑：cargo clean${d.includes("android") ? `（先 export CARGO_TARGET_DIR=src-tauri/target-android）` : ""}`);
  }

  if (!yes) {
    console.log(`\n未删除任何文件。执行安全档：npm run clean -- --yes；连 promo 缓存一起：npm run clean:deep -- --yes`);
    return;
  }
  for (const f of safe) {
    try {
      rmSync(f.path, { force: true });
    } catch (e) {
      console.warn(`  删除失败（可能被占用）: ${f.path} — ${e.message}`);
    }
  }
  console.log(`安全档已释放约 ${fmtSize(bytes)}。`);
  if (deep) {
    for (const d of deepDirs) {
      rmSync(join(ROOT, d), { recursive: true, force: true });
      console.log(`已删 ${d}`);
    }
  }
}

// 被单测 import 时不自动执行
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
