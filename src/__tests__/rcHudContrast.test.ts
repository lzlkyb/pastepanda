/**
 * 会话侧「连接详情」面板的对比度守卫（2026-09-27 审计 P1-4）。
 *
 * # 缺陷
 *
 * 面板浮在**不可控的远端画面**上（可能是白色 Word / 网页），而里面三档灰字
 * 的 α 低到在读不出的程度。审计实测（Edge headless + CDP 对 dist 编译产物）：
 *
 * | 元素 | 白底屏 | 黑底屏 |
 * |---|---|---|
 * | `.hudRowLabel` α .45 | **2.94** | 3.30 |
 * | `.hudRowHint` α .38 | **2.51** | 2.69 |
 * | `.hudTrendHead` α .50 | **3.28** | 3.81 |
 * | `.hudPanelHead` α .62 | **4.21** | 5.28 |
 *
 * 这正是用户读排障数字的地方（延迟 / 丢包 / 码率）。
 *
 * # 为什么这个 P1 能活到线上
 *
 * A2 那张样式表有 `rcA2ThemeTokens.test.ts` 钉着「主按钮对比度 ≥ 4.5」，
 * **会话侧一条都没有**。所以这里补的是那个缺口的同类守卫。
 *
 * # 两条设计上的讲究
 *
 * ① **不抄常量，直接读 CSS。** α 抄进测试就等于埋了第二份真相，改 CSS 不改
 *    测试时守卫会假绿。这里解析 `RemoteComputer.module.css` 的真实声明值
 *    —— 谁把 α 调低，这条测试就红，而且是「CSS 改了」这件事本身触发的。
 * ② **带一条「旧值必须失败」的证伪用例。** 只有「新值通过」的话，把对比度公式
 *    写反（或把门槛写成 1.5）也会全绿。先断言修前的四个 α 在**白底**上确实
 *    < 4.5，这条测试才被证明真的在算东西。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(process.cwd(), "src", "components", "rc", "RemoteComputer.module.css"),
  "utf8",
);

/* ── 极简 CSS 声明读取：只认「行首 .sel { … }」的扁平规则块 ── */

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`找不到规则块 ${selector}`);
  return m[1];
}

type Rgba = [number, number, number, number];

function parseRgba(text: string, what: string): Rgba {
  const m = text.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) throw new Error(`${what} 里找不到 rgba()`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

function bg(selector: string): Rgba {
  const m = block(selector).match(/(?:^|[\s;])background:\s*([^;]+);/);
  if (!m) throw new Error(`${selector} 里找不到 background`);
  return parseRgba(m[1], `${selector} 的 background`);
}

function fg(selector: string): Rgba {
  const m = block(selector).match(/(?:^|[\s;])color:\s*([^;]+);/);
  if (!m) throw new Error(`${selector} 里找不到 color`);
  return parseRgba(m[1], `${selector} 的 color`);
}

/* ── WCAG 2.x 相对亮度 / 对比度（合成后再算，不是拿声明值直接比） ── */

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgba) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fgc: Rgba, bgc: Rgba): Rgba => {
  const a = fgc[3];
  return [fgc[0] * a + bgc[0] * (1 - a), fgc[1] * a + bgc[1] * (1 - a), fgc[2] * a + bgc[2] * (1 - a), 1];
};

/** 远端画面的两种极端背景。面板浮在其上 ⇒ 面板底先与它合成。 */
const SCREENS: Record<string, Rgba> = {
  黑底远终端: [0, 0, 0, 1],
  白底文档: [255, 255, 255, 1],
};

/** 元素在给定远端背景下的实际对比度。 */
function contrastOn(screen: Rgba, panel: Rgba, text: Rgba) {
  const composed = over(panel, screen);
  return ratio(over(text, composed), composed);
}

const THRESHOLD = 4.5;

/* ── 被测的四处（默认文字，非大字 ⇒ 门槛 4.5） ── */

const CASES = [
  [".hudPanelHead", "面板抬头"],
  [".hudRowLabel", "行标签"],
  [".hudRowHint", "行提示"],
  [".hudTrendHead", "趋势抬头"],
] as const;

describe("会话侧 HUD 面板对比度（P1-4）", () => {
  const panel = bg(".hudPanel");

  it("面板底与面板内文字都还是半透明玻璃（没被顺手改成实色）", () => {
    expect(panel[3]).toBeGreaterThan(0);
    expect(panel[3]).toBeLessThan(1);
    for (const [sel] of CASES) {
      expect(fg(sel)[3], `${sel} 应当仍用 α 表达层级`).toBeLessThan(1);
    }
  });

  for (const [sel, label] of CASES) {
    it(`${label} ${sel}：黑底与白底两种远端画面上都 ≥ ${THRESHOLD}:1`, () => {
      const text = fg(sel);
      for (const [screenName, screen] of Object.entries(SCREENS)) {
        const got = contrastOn(screen, panel, text);
        expect(
          got,
          `${sel} 在「${screenName}」上只有 ${got.toFixed(2)}:1（α=${text[3]}）`,
        ).toBeGreaterThanOrEqual(THRESHOLD);
      }
    });
  }

  it("锚点：行值 .hudRowVal 也达标（对照组说明伤只在低 α 灰字上）", () => {
    const text = fg(".hudRowVal");
    for (const screen of Object.values(SCREENS)) {
      expect(contrastOn(screen, panel, text)).toBeGreaterThanOrEqual(THRESHOLD);
    }
  });

  /**
   * 🔴 证伪用例：修前的那四个 α 必须在白底上失败。
   * 否则把公式写反（或把门槛改小）也能全绿 —— 这条测试就没在测东西。
   */
  it("证伪：修前的 α 值在白底屏上确实不达标（证明本文件的算法与门槛是真的）", () => {
    const before: ReadonlyArray<[string, number, number]> = [
      [".hudPanelHead 旧 α .62", 0.62, 4.0], // 预期落在 4.0 ~ 4.5 之间
      [".hudRowLabel 旧 α .45", 0.45, 3.0],
      [".hudRowHint 旧 α .38", 0.38, 2.6],
      [".hudTrendHead 旧 α .50", 0.5, 3.3],
    ];
    const white = SCREENS["白底文档"];
    for (const [, alpha, expectAround] of before) {
      const base = fg(".hudRowHint");
      const got = contrastOn(white, panel, [base[0], base[1], base[2], alpha]);
      expect(got, `旧 α ${alpha} 竟达标了？门槛或公式可能被改坏`).toBeLessThan(THRESHOLD);
      expect(Math.abs(got - expectAround)).toBeLessThan(0.35);
    }
  });

  it("证伪：若把面板底改成实色，文字 α 的门槛并不因此消失（不能靠抬底绕开）", () => {
    const text = [200, 208, 220, 0.55] as Rgba;
    const opaquePanel = [9, 17, 28, 1] as Rgba;
    // 实色面板下 .55 依旧不足 4.5 —— 说明「抬底」不是文字 α 的替代品
    expect(contrastOn(SCREENS["黑底远终端"], opaquePanel, text)).toBeLessThan(THRESHOLD);
  });
});
