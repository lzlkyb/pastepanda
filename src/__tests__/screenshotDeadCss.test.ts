/**
 * 死 CSS 守卫（截图浮层，方案 B 设计稿 §7 乙档）。
 *
 * 钉住的不变量：`src/styles/screenshot.css` 里每个类名都必须能在 ts/tsx 里找到出处。
 * 上一轮整改删掉的 `.snap-rect` / `.snap-tip` 是靠人眼扫出来的，扫一遍记不住、
 * 也拦不住下一个写 `.foo-bar {}` 却发现早已被搬走的人 —— 所以把判据写成测试。
 *
 * 口径（这两条是测试成立的前提，改任何一条都要先改这里）：
 * ① 先剥 CSS 注释：注释里提到的类名（如「已删：.toolbar-select」）不算声明；
 * ② 动态拼接的类名要有**构造点证据**：`.h-nw` 这类来自 `className={`sel-handle h-${dir}`}`，
 *    字面量在源码里根本不存在。没有构造点就不许进白名单，否则白名单会变成第二个坟场。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const cssPath = resolve(root, "src/styles/screenshot.css");
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) return p.includes("__tests__") ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}
const srcFiles = walk(resolve(root, "src"));
const src = srcFiles.map((f) => readFileSync(f, "utf8")).join("\n");

/** 选择器（非注释）里出现过的全部类名 */
const declared = new Set<string>();
for (const block of css.matchAll(/([^{}]+)\{/g))
  for (const sel of block[1].split(","))
    for (const m of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) declared.add(m[1]);

/** 靠模板字符串拼出来的类名：值前缀必须在源码里有构造点 */
const DYNAMIC = /^h-(n|s|e|w|nw|ne|se|sw)$/;

describe("screenshot.css 不许有死规则", () => {
  it("CSS 声明了 190+ 个类名（先确认扫描本身在工作）", () => {
    expect(declared.size).toBeGreaterThan(150);
  });

  it("动态白名单里的前缀必须有真实构造点", () => {
    const dynamic = [...declared].filter((n) => DYNAMIC.test(n));
    expect(dynamic.length).toBeGreaterThan(0);
    // 构造点形如 `... h-${dir}`；少了这条断言，白名单会在功能被删后继续谎报「有出处」
    expect(src).toMatch(/className=\{`[\s\S]{0,40}?h-\$\{/);
  });

  it("每个类名都能在 ts/tsx 里找到出处", () => {
    const dead = [...declared].filter(
      (n) => !DYNAMIC.test(n) && !src.includes(`"${n}"`) && !src.includes(`${n}`)
    );
    expect(dead, `screenshot.css 里的死类名：${dead.join(", ")}`).toEqual([]);
  });
});

describe("已删的死规则不许回来", () => {
  it.each([".snap-rect", ".snap-tip", ".toolbar-select", ".toolbar-annot"])(
    "%s 已随功能搬走，CSS 里不得再声明",
    (sel) => {
      expect(css).not.toContain(sel);
    }
  );
});
