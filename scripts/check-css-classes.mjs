#!/usr/bin/env node
/**
 * CSS module 类名引用校验。
 *
 * 为什么需要它：CSS module 对「引用了不存在的类」**不报错**。
 * `styles.foo` 指向一个 CSS 里没有的类时，值直接是 `undefined`，
 * `className` 变成 "undefined"，**样式静默全丢**——而 `tsc` 和 `vitest`
 * 都发现不了（CSS module 的类型是宽松的 Record<string,string> 语义）。
 *
 * 2026-09-16 在 RcSessionHistory.tsx 上真漏过一次：组件已切到
 * histItem/histInfo/histTime，但 CSS 里没定义这三个类，会话历史列表样式全丢。
 *
 * 用法：
 *   node scripts/check-css-classes.mjs              扫全 src（默认）
 *   node scripts/check-css-classes.mjs <文件...>    只检查给定文件（husky 传暂存文件用）
 *   node scripts/check-css-classes.mjs --unused     反向：列出 CSS 里无人引用的类
 *   node scripts/check-css-classes.mjs --quiet      只输出结论行
 *
 * 退出码：有引用错误 → 1；否则 0。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const fileArgs = argv.filter((a) => !a.startsWith("--"));
const WANT_UNUSED = flags.has("--unused");
const QUIET = flags.has("--quiet");
const SOURCE_EXT = new Set([".ts", ".tsx"]);

/**
 * 只扫「选择器文本」，不扫属性值——否则 `url(a.svg)` 里的 `.svg`、
 * `transition: .2s` 之后的东西都会被当成类名，把「已定义集合」撑大，
 * 反而掩盖真实的缺失类。
 */
function selectorClasses(css) {
  const out = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const headerRe = /([^{}]+)\{/g;
  let m;
  while ((m = headerRe.exec(noComments)) !== null) {
    const selector = m[1];
    const clsRe = /\.(-?[_a-zA-Z][\w-]*)/g;
    let c;
    while ((c = clsRe.exec(selector)) !== null) {
      // 行号：选择器文本起点之前有多少个换行
      const line = noComments.slice(0, m.index).split("\n").length;
      out.push({ name: c[1], line });
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      walk(p, acc);
    } else if (SOURCE_EXT.has(path.extname(ent.name))) {
      acc.push(p);
    }
  }
  return acc;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

/** 把 import 说明符解析成绝对路径：支持 `./x` 与 `@/x` 两种写法 */
function resolveSpec(file, spec) {
  if (spec.startsWith("@/")) return path.join(ROOT, "src", spec.slice(2));
  return path.resolve(path.dirname(file), spec);
}

/**
 * 剥掉 JS/TS 注释，**保持总长度不变**（非换行字符替换成空格），这样后续的行号计算不用改。
 *
 * 🔴 必须剥：本仓库有习惯在注释里引用已删除的类名做说明，例如
 * `ProfileExport.tsx` 写着「原先引的 styles.exportTitle 在 css 里不存在，
 * 是悬空引用」——不剥注释就会把它当成真引用，报出假错误。
 * 反向检查（--unused）同理：`styles.x` 若只出现在注释里，那个类仍然是死的。
 *
 * 字符串**不剥**：`${styles.foo}` 这类模板串是真引用。
 */
function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // 行注释：`//` 前不能是 `:`（避开 https://）、引号或词字符（避开 "//path"）
    .replace(/(^|[^:\w"'`])\/\/[^\n]*/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** 读一个源文件里「对某个 CSS module 的别名 → 引用到的类」 */
function refsOf(file) {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  const imports = [];
  const impRe = /import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g;
  let m;
  while ((m = impRe.exec(src)) !== null) {
    const cssPath = resolveSpec(file, m[2]);
    imports.push({ alias: m[1], cssPath, index: m.index });
  }
  if (!imports.length) return null;

  // 每个别名各自的行号基准（把别名声明之前的内容替换成等长空白，行号才不会串）
  const lines = [];
  for (const im of imports) {
    const head = src.slice(0, im.index + `import ${im.alias} from`.length);
    const baseLine = head.split("\n").length - 1;
    const refRe = new RegExp(`\\b${im.alias}\\.([A-Za-z_][\\w]*)`, "g");
    let r;
    while ((r = refRe.exec(src)) !== null) {
      lines.push({ alias: im.alias, name: r[1], line: baseLine + src.slice(im.index, r.index).split("\n").length });
    }
  }
  const dynamic = imports.some((im) => new RegExp(`\\b${im.alias}\\s*\\[`).test(src));
  return { imports, refs: lines, dynamic };
}

const targets = fileArgs.length
  ? fileArgs.map((f) => path.resolve(ROOT, f)).filter((f) => fs.existsSync(f) && SOURCE_EXT.has(path.extname(f)))
  : walk(SRC);

const cssCache = new Map();
function cssInfo(cssPath) {
  if (!cssCache.has(cssPath)) {
    const text = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : null;
    cssCache.set(
      cssPath,
      text === null ? null : { text, classes: selectorClasses(text) },
    );
  }
  return cssCache.get(cssPath);
}

const errors = [];
const moduleUsers = new Map(); // cssPath -> Set(file)
let checkedFiles = 0;
let checkedRefs = 0;

for (const file of targets) {
  const info = refsOf(file);
  if (!info) continue;
  checkedFiles++;
  for (const im of info.imports) {
    if (!moduleUsers.has(im.cssPath)) moduleUsers.set(im.cssPath, new Set());
    moduleUsers.get(im.cssPath).add(file);
  }
  const missingModules = new Set();
  for (const im of info.imports) {
    if (cssInfo(im.cssPath) === null && !missingModules.has(im.cssPath)) {
      missingModules.add(im.cssPath);
      errors.push(`${rel(file)}  →  CSS 文件不存在：${rel(im.cssPath)}`);
    }
  }
  for (const r of info.refs) {
    checkedRefs++;
    const im = info.imports.find((i) => i.alias === r.alias);
    const ci = im && cssInfo(im.cssPath);
    if (!ci) continue;
    if (!ci.classes.some((c) => c.name === r.name)) {
      errors.push(`${rel(file)}:${r.line}  ${r.alias}.${r.name}  →  未在 ${rel(im.cssPath)} 中定义（className 会是 undefined，样式静默全丢）`);
    }
  }
}

if (!QUIET) {
  console.log(`CSS module 类名引用校验：扫了 ${checkedFiles} 个文件 / ${checkedRefs} 处引用`);
}

let exitCode = 0;
if (errors.length) {
  console.log("");
  console.log(`发现 ${errors.length} 处引用错误：`);
  for (const e of errors) console.log("  " + e);
  exitCode = 1;
} else if (!QUIET) {
  console.log("  ✅ 全部引用都能在对应 CSS 里找到定义");
}

if (WANT_UNUSED) {
  console.log("");
  console.log("── 反向检查：CSS 里没人引用的类 ──");
  const allCss = [];
  const collectCss = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
        collectCss(p);
      } else if (ent.name.endsWith(".module.css")) allCss.push(p);
    }
  };
  collectCss(SRC);
  // 全量收集引用（不受 fileArgs 限制，否则反向检查会误报）
  const refByCss = new Map();
  const dynamicByCss = new Set();
  for (const file of walk(SRC)) {
    const info = refsOf(file);
    if (!info) continue;
    for (const im of info.imports) {
      if (info.dynamic) dynamicByCss.add(im.cssPath);
      if (!refByCss.has(im.cssPath)) refByCss.set(im.cssPath, new Set());
      const set = refByCss.get(im.cssPath);
      for (const r of info.refs) set.add(r.name);
    }
  }
  let totalUnused = 0;
  for (const cssPath of allCss.sort()) {
    const ci = cssInfo(cssPath);
    if (!ci) continue;
    const used = refByCss.get(cssPath) || new Set();
    const seen = new Set();
    const unused = [];
    for (const c of ci.classes) {
      if (seen.has(c.name) || used.has(c.name)) continue;
      seen.add(c.name);
      unused.push(c);
    }
    if (!unused.length) continue;
    totalUnused += unused.length;
    const dyn = dynamicByCss.has(cssPath) ? "  ⚠️ 该 module 有 styles[...] 动态访问，结果可能不完整" : "";
    console.log(`  ${rel(cssPath)}  未引用 ${unused.length} 个${dyn}`);
    if (!QUIET) console.log(`      ${unused.map((c) => `.${c.name}(L${c.line})`).join(" ")}`);
  }
  console.log(`  合计 ${totalUnused} 个未被直接引用的类名`);
}

process.exit(exitCode);
