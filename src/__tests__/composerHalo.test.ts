/**
 * 提问框光晕（Composer）令牌守卫。
 *
 * 钉的是六条**量出来**的结论，不是审美：
 *  1. `--composer-*` 只在 `:root` 写一次，六套主题靠 --accent/--orange 自动派生
 *     ——一旦有人在任何 `[data-theme]` 块里覆写，稿 §4 那张逐主题对比度表就整体作废。
 *  2. 光晕两端**不许混色**。`color-mix(in oklch, accent, orange)` 在 ocean 实测解析成
 *     #bf477a（oklch 走短弧 40°→250° 穿紫），出来的不是参考图那道暖桃。
 *  3. 焦点外环必须是**实色 --accent**。12% 淡环六套全读成 1.13–1.19:1，够不到 U7 的 3:1。
 *  4. `transition` 里不许写 `background`。实测（稿子页 evaluate）Chromium 不过渡
 *     background-image 的渐变，写了就是声明一条不会动的动画。
 *  5. 发送钮底色是 `--accent-solid`，且**这里现算**白字对比度六套全 ≥4.5:1
 *     （旧 .followGo 的渐变两头都是 --accent 家族，实测 2.79–4.10:1）。
 *  6. 它的 hover 只能压暗：opacity 与 brightness(>1) 实测都把白字拉回 4.5 以下。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const theme = strip(readFileSync(resolve(root, "src/styles/theme.css"), "utf8"));
const composerCss = strip(readFileSync(resolve(root, "src/components/Composer.module.css"), "utf8"));

/** 包住这个偏移的那一层选择器头（theme.css 是单层结构；嵌套只可能是 @keyframes/@media） */
function headerAt(text: string, pos: number): string {
  const matches = [...text.slice(0, pos).matchAll(/([^{}]+)\{/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : "";
}

/**
 * 找 `--x: v;` 这类声明。
 *
 * ❗ 名字传**不带冒号**的令牌名：正则要求紧跟冒号，所以查 `--composer-halo-a`
 * 不会把 `--composer-halo-a-rest` 一起捞进来，查 `--orange` 也不会捞 `--orange-solid`。
 */
function decls(text: string, token: string) {
  const out: { value: string; header: string }[] = [];
  const re = new RegExp(`${token}\\s*:\\s*([^;]+);`, "g");
  for (const m of text.matchAll(re)) {
    out.push({ value: m[1].trim(), header: headerAt(text, m.index) });
  }
  return out;
}

const TOKENS = [
  "--composer-halo-a",
  "--composer-halo-b",
  "--composer-halo-rest",
  "--composer-halo-focus",
  "--composer-halo-a-rest",
  "--composer-halo-b-rest",
  "--composer-halo-a-focus",
  "--composer-halo-b-focus",
];

describe("提问框光晕令牌", () => {
  it("八个令牌都只定义一次，且全部落在 :root 里", () => {
    for (const token of TOKENS) {
      const found = decls(theme, token);
      expect(found, `${token} 应该恰好定义一次`).toHaveLength(1);
      expect(found[0].header, `${token} 必须写在 :root，不允许逐主题覆写`).toBe(":root");
    }
  });

  it("六套主题都给了两个派生源（--orange / --accent），少一套就有一条主题没有光晕", () => {
    for (const token of ["--orange", "--accent"]) {
      expect(decls(theme, token), `${token} 必须每套主题各一次`).toHaveLength(6);
    }
  });

  it("静息档严格低于焦点档，且两端点不混色", () => {
    const rest = Number(decls(theme, "--composer-halo-rest")[0].value);
    const focus = Number(decls(theme, "--composer-halo-focus")[0].value);
    expect(rest).toBeGreaterThanOrEqual(0);
    expect(rest).toBeLessThan(focus);
    expect(focus).toBeLessThanOrEqual(100);
    // 端点就是本色：混色那两条尝试（oklch / 加权 srgb）实测都穿紫
    expect(decls(theme, "--composer-halo-a")[0].value).toBe("var(--orange)");
    expect(decls(theme, "--composer-halo-b")[0].value).toBe("var(--accent)");
  });

  it("四个派生值是同色相改 alpha，不是换色相（srgb + calc(× 1%)）", () => {
    const pairs: [string, string, string][] = [
      ["--composer-halo-a-rest", "--composer-halo-a", "rest"],
      ["--composer-halo-b-rest", "--composer-halo-b", "rest"],
      ["--composer-halo-a-focus", "--composer-halo-a", "focus"],
      ["--composer-halo-b-focus", "--composer-halo-b", "focus"],
    ];
    for (const [token, source, strength] of pairs) {
      expect(decls(theme, token)[0].value).toBe(
        `color-mix(in srgb, var(${source}) calc(var(--composer-halo-${strength}) * 1%), transparent)`,
      );
    }
  });

  it("消费侧只认语义名，且焦点环是实色 --accent", () => {
    // U6：色名变量不许出现在新代码里（只有令牌定义处允许）
    expect(composerCss).not.toMatch(/var\(\s*--(red|green|blue|orange|yellow|purple|pink|cyan)\b/);
    expect(composerCss).toContain("var(--composer-halo-a-rest)");
    expect(composerCss).toContain("var(--composer-halo-a-focus)");
    expect(composerCss).toMatch(/box-shadow:\s*var\(--control-elev\),\s*0 0 0 3px var\(--accent\);/);
  });

  it("没有给不会动的 background 声明过渡（渐变在 Chromium 里不参与插值）", () => {
    const transitions = [...composerCss.matchAll(/transition:\s*([^;]+);/g)];
    expect(transitions.length).toBeGreaterThan(0); // 一条都没有也算判据失效
    for (const m of transitions) {
      expect(m[1]).not.toMatch(/background|border-color/);
      expect(m[1]).toMatch(/(?:^|\D)(150|200|300|400)ms/);
    }
  });

  /* 发送钮是「实心底 + 白字」，本仓对这一搭配有专门的令牌（--accent-solid），
     而旧 .followGo 的 linear-gradient(--accent, --accent-strong) 不达标：
     白字压 --accent 实测 2.79–4.10:1，且午夜/海洋两套的 --accent-strong 就等于
     --accent，渐变两头都救不了。这里逐主题重算，不引用注释里的数。 */
  it("发送钮的实心底在白字下六套全过 4.5:1，且用的就是 --accent-solid", () => {
    const rule = composerCss.match(/\.composerSend\s*\{([\s\S]*?)\}/);
    expect(rule, "找不到 .composerSend 规则").not.toBeNull();
    const bg = rule![1].match(/background:\s*([^;]+);/);
    expect(bg, ".composerSend 必须显式给底色").not.toBeNull();
    expect(bg![1].trim()).toBe("var(--accent-solid)");

    const solids = decls(theme, "--accent-solid");
    expect(solids).toHaveLength(6);
    for (const s of solids) {
      expect(ratioWithWhite(s.value), `白字压 --accent-solid ${s.value}`).toBeGreaterThanOrEqual(4.5);
    }
    // 反证这条规则为什么存在：同六套里至少有一套，白字压 --accent 连图形门槛 3:1 都不到
    const accents = decls(theme, "--accent").map((a) => ratioWithWhite(a.value));
    expect(Math.min(...accents)).toBeLessThan(3);
  });

  it("hover 用压暗（提对比度），不是 opacity / brightness(>1)（两者都把白字拉回 4.5 以下）", () => {
    const hover = composerCss.match(/\.composerSend:hover:not\(:disabled\)\s*\{([\s\S]*?)\}/);
    expect(hover, "找不到 .composerSend:hover 规则").not.toBeNull();
    expect(hover![1]).not.toMatch(/opacity/);
    const k = hover![1].match(/filter:\s*brightness\(\s*([0-9.]+)\s*\)/);
    expect(k, "hover 必须是 brightness(...)").not.toBeNull();
    expect(Number(k![1])).toBeLessThan(1);
  });
});

/** WCAG 相对亮度与「白字压在某色上」的对比度 */
function ratioWithWhite(hex: string): number {
  const m = hex.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`不是 6 位十六进制，量不了对比度：${hex}`);
  const f = (i: number) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
  return 1.05 / (l + 0.05);
}
