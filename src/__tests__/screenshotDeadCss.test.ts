/**
 * 死 CSS 守卫（截图浮层，方案 B 设计稿 §7 乙档）。
 *
 * 钉住的不变量：`src/styles/screenshot.css` 里每个类名都必须能在 ts/tsx 里找到出处。
 * 上一轮整改删掉的 `.snap-rect` / `.snap-tip` 是靠人眼扫出来的，扫一遍记不住、
 * 也拦不住下一个写 `.foo-bar {}` 却发现早已被搬走的人 —— 所以把判据写成测试。
 *
 * 口径（这三条是测试成立的前提，改任何一条都要先改这里）：
 * ① 先剥 CSS / TS 注释：注释里提到的类名（如「已删：.toolbar-select」）既不算声明、
 *    也不算出处——上一版的判据是 `src.includes(类名)`，而注释和长单词都会命中，
 *    实测对整改前的 192 个类名报出 **0 个死类名**（等于没有守卫）；
 * ② 消费域限定在截图目录（`src/components/screenshot` + `src/lib/screenshot`）：
 *    这份 CSS 只被截图窗消费，域一宽，别处组件里的同名标识符就会替死类名作保；
 * ③ 整词匹配，不做子串：`.net` 在 `Internet` / `hotkey_register` 里到处都是子串，
 *    按子串判它「有出处」就是假绿；按整词判才抓得住（整改前它确实死了）。
 *
 * 动态拼接的类名要有**构造点证据**：`.h-nw` 这类来自 `className={`sel-handle h-${dir}`}`，
 * 字面量在源码里根本不存在。没有构造点就不许进白名单，否则白名单会变成第二个坟场。
 *
 * 本守卫查不到的一类（认了，不再加机制）：**复合选择器的修饰位**。`.act-row.primary`
 * 里 `primary` 作为整词在 `.pop-foot .fb.primary` 那边活得好好的，名字级判据永远放行；
 * 要抓它得做「基础类 × 修饰位同现」的 pair 分析，代价大于收益。它已人工删除，
 * 名字进了下方「不许回来」清单——再加一次会被抓住，第三次不会。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const cssPath = resolve(root, "src/styles/screenshot.css");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const css = stripComments(readFileSync(cssPath, "utf8"));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) return p.includes("__tests__") ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** 把源码切成「能当类名用的整词」集合：非类名字符全部当分隔符 */
function tokenize(src: string): Set<string> {
  return new Set(stripComments(src).split(/[^A-Za-z0-9_-]+/));
}

const CONSUMER_DIRS = ["src/components/screenshot", "src/lib/screenshot"];
const corpus = CONSUMER_DIRS.flatMap((d) => walk(resolve(root, d))).map((f) =>
  readFileSync(f, "utf8")
);
const used = new Set<string>(corpus.flatMap((c) => [...tokenize(c)]));

/** 选择器（非注释）里出现过的全部类名 */
const declared = new Set<string>();
for (const block of css.matchAll(/([^{}]+)\{/g))
  for (const sel of block[1].split(","))
    for (const m of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) declared.add(m[1]);

/** 靠模板字符串拼出来的类名：值前缀必须在源码里有构造点 */
const DYNAMIC = /^h-(n|s|e|w|nw|ne|se|sw)$/;

describe("screenshot.css 不许有死规则", () => {
  it("扫描本身在工作（CSS 类名数 + 消费域文件数都要够）", () => {
    expect(declared.size).toBeGreaterThan(150);
    expect(corpus.length).toBeGreaterThan(30);
  });

  it("判据是整词而不是子串（守卫不是假绿）", () => {
    // 上一版就死在这里：`Internet` / `hotkey_register` 含子串 "net"，于是已删的
    // `.pop-row .net` 被判成「有出处」。这一条钉住区分能力本身。
    expect("internet hotkey_register".includes("net")).toBe(true);
    expect(tokenize("internet hotkey_register").has("net")).toBe(false);
    // 反向也要成立：真类名（三元里的 `? " discover" :`）必须被收进集合
    expect(used.has("discover")).toBe(true);
    // 消费域必须真的限定过：全站其它角落的标识符不许替截图的死类名作保
    expect(used.has("orgSave")).toBe(false);
  });

  it("动态白名单里的前缀必须有真实构造点", () => {
    const dynamic = [...declared].filter((n) => DYNAMIC.test(n));
    expect(dynamic.length).toBeGreaterThan(0);
    // 构造点形如 `... h-${dir}`；少了这条断言，白名单会在功能被删后继续谎报「有出处」
    expect(corpus.join("\n")).toMatch(/className=\{`[\s\S]{0,40}?h-\$\{/);
  });

  it("每个类名都能在截图消费域里找到整词出处", () => {
    const dead = [...declared].filter((n) => !DYNAMIC.test(n) && !used.has(n));
    expect(dead, `screenshot.css 里的死类名：${dead.join(", ")}`).toEqual([]);
  });
});

describe("已删的死规则不许回来", () => {
  it.each([".snap-rect", ".snap-tip", ".toolbar-select", ".toolbar-annot", ".ocr-pill"])(
    "%s 已随功能搬走，CSS 里不得再声明",
    (sel) => {
      expect(css).not.toContain(sel);
    }
  );

  it("识别中的浮动胶囊与 .net 修饰位不得回来（转圈只留 .ocr-spin 那一颗）", () => {
    expect(css).not.toMatch(/\.spinner\b/);
    expect(css).not.toMatch(/\.net\b/);
    expect(css).not.toMatch(/@keyframes\s+ocrPillIn\b/);
  });
});
