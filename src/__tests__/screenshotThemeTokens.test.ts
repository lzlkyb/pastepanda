/**
 * 截图主题令牌化守卫测试（方案 B，design/PastePanda-截图主题适配-设计稿.html）。
 *
 * 钉住的不变量（规则 11.1：被后人改坏时必须立刻红灯）：
 * ① theme.css 的 6 套主题**全部**定义 --shot-* 令牌族（漏一套 = 某主题截图浮层回退深色）；
 * ② screenshot.css 的浮层表面全部走令牌（新增硬编码表面色 = 测试失败）；
 * ③ 白字实色底一律 --accent-solid（.tool.on / .done-btn / .badge），不得回归写死蓝紫渐变；
 * ④ AI 品牌渐变重绑 hack 已删除（screenshot.css 里只允许 var() 引用，不允许重新定义）；
 * ⑤ 两个独立窗口入口跟随主题（不得回归 applyTheme("midnight")，必须监听 theme-changed）。
 *
 * 为什么读文件而不是渲染：CSS 令牌无法在 vitest 的 jsdom 里验证（样式表被 stub），
 * 而「第 7 个调用点走错」恰恰发生在 CSS 里，所以直接对源文件做静态守卫。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest 从项目根目录启动，process.cwd() = 项目根（import.meta.url 在 vitest 下不是 file scheme，不能用）
const root = process.cwd();
const cssPath = resolve(root, "src/styles/screenshot.css");
const themePath = resolve(root, "src/styles/theme.css");
const shotMainPath = resolve(root, "src/screenshot-main.tsx");
const longshotMainPath = resolve(root, "src/longshot-main.tsx");

const screenshotCss = readFileSync(cssPath, "utf8");
const themeCss = readFileSync(themePath, "utf8");
const shotMain = readFileSync(shotMainPath, "utf8");
const longshotMain = readFileSync(longshotMainPath, "utf8");

/** 提取某选择器在 CSS 里的首个声明块（选择器可能以逗号分组出现），未命中返回 "" */
function firstBlockOf(selectorToken: string): string {
  const i = screenshotCss.indexOf(selectorToken);
  if (i === -1) return "";
  const brace = screenshotCss.indexOf("{", i);
  if (brace === -1) return "";
  let depth = 1;
  let j = brace + 1;
  while (j < screenshotCss.length && depth > 0) {
    if (screenshotCss[j] === "{") depth++;
    else if (screenshotCss[j] === "}") depth--;
    j++;
  }
  return screenshotCss.slice(brace + 1, j - 1);
}

/** 提取某选择器（选择器以 " {" 收尾，非分组变体）的全部声明块 */
function blocksOf(selector: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const i = screenshotCss.indexOf(selector + " {", from);
    if (i === -1) break;
    const brace = screenshotCss.indexOf("{", i + selector.length);
    let depth = 1;
    let j = brace + 1;
    while (j < screenshotCss.length && depth > 0) {
      if (screenshotCss[j] === "{") depth++;
      else if (screenshotCss[j] === "}") depth--;
      j++;
    }
    out.push(screenshotCss.slice(brace + 1, j - 1));
    from = j;
  }
  return out;
}

/** 断言某个类的主声明块（含分组）引用某令牌；classToken 如 ".tool.done-btn" */
function expectBlockToken(classToken: string, token: string) {
  const re = new RegExp(
    classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{]*\\{[^}]*" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  expect(screenshotCss, `${classToken} 主声明块应引用 ${token}`).toMatch(re);
}

describe("截图主题令牌化守卫", () => {
  it("theme.css 六套主题全部定义 --shot-* 令牌族", () => {
    const tokens = [
      "--shot-bar-bg:",
      "--shot-bar-border:",
      "--shot-bar-text:",
      "--shot-bar-muted:",
      "--shot-hover:",
      "--shot-save:",
      "--shot-long:",
      "--shot-pin:",
      "--shot-ocr:",
    ];
    for (const tok of tokens) {
      const n = (themeCss.match(new RegExp(tok.replace(/[:]/g, "\\:"), "g")) ?? []).length;
      expect(n, `${tok} 应恰好定义 6 次（六套主题各一次），实际 ${n} 次`).toBe(6);
    }
  });

  it("浮层表面主声明块全部令牌化", () => {
    const surfaces = [
      ".annot-toolbar",
      ".attr-bar",
      ".shot-tip",
      ".mode-pill",
      ".mask-bar",
      ".text-toolbar",
      ".ocr-copy-bar",
      ".ocr-pill",
      ".shot-toast",
      ".picker-bar",
      ".mag-view",
      ".ls-bar",
      ".sel-size",
      ".snap-tip",
      ".shot-hint",
    ];
    for (const sel of surfaces) {
      const b = firstBlockOf(sel);
      expect(b.length, `${sel} 应有声明块`).toBeGreaterThan(0);
      expect(
        b,
        `${sel} 主声明块必须引用 --shot-* 令牌（背景/描边/文字走令牌，禁止硬编码表面色）`,
      ).toMatch(/--shot-(bar-(bg|border|text|muted)|save|pin|ocr|long|hover)/);
    }
    // .shot-hint 有顶部 + 底部两条，都必须令牌化
    const hintBlocks = blocksOf(".shot-hint");
    expect(hintBlocks.length).toBe(2);
    for (const b of hintBlocks) {
      expect(b).toMatch(/--shot-(bar-(bg|border|text|muted)|save|pin|ocr|long|hover)/);
    }
  });

  it("白字实色底一律走 --accent-solid（选中工具 / 完成 / 角标）", () => {
    expectBlockToken(".tool.on", "var(--accent-solid");
    expectBlockToken(".tool.done-btn", "var(--accent-solid");
    expectBlockToken(".tool .badge", "var(--accent-solid");
    // 不允许回归写死的蓝紫渐变
    expect(screenshotCss).not.toMatch(/linear-gradient\(135deg, #3B9EFF/);
  });

  it("出口语义色走 --shot-* 令牌（保存 / 贴图 / 取文字 / 长截图）", () => {
    expectBlockToken(".tool.exit-save", "var(--shot-save");
    expectBlockToken(".tool.exit-pin", "var(--shot-pin");
    expectBlockToken(".tool.ocr-btn", "var(--shot-ocr");
    expectBlockToken(".tool.longshot", "var(--shot-long");
  });

  it("AI 品牌渐变重绑 hack 已删除（只允许 var() 引用，不允许重新定义）", () => {
    // .tool.exit-ai 仍然 var(--brand-ai-from) 引用主题令牌，但 .annot-toolbar 不再重绑定义
    expect(screenshotCss).toMatch(/\.tool\.exit-ai[^{]*\{[^}]*var\(--brand-ai-from/);
    expect(screenshotCss.match(/--brand-ai-from\s*:/g)).toBeNull();
  });

  it("入口跟随主题：screenshot-main / longshot-main 不得回归写死 midnight", () => {
    for (const src of [shotMain, longshotMain]) {
      expect(src).not.toContain('applyTheme("midnight")');
      expect(src).toContain('"theme-changed"');
      expect(src).toContain('"get_config"');
      expect(src).toContain("normalizeTheme");
    }
  });
});
