/**
 * 录屏玻璃条字色 AA 守卫（2026-10-10 五期甲案 §5.1）。
 *
 * 钉两条**现网既有缺陷**的修法，且必须在 6 个主题下都成立：
 * ① `.rec-glass-lnk`（预览条/确认条上的「✕ 退出」「整屏 →」）曾用裸 `var(--accent)`
 *    当文字色——四个浅色主题实测 4.10 / 3.77 / 3.27 / 3.01，全不过 AA 的 4.5:1；
 * ② `.rec-snd.off`（音源关闭态弱字）曾用 `--shot-bar-text` 40% —— **6 个主题全不过**
 *    （3.30→2.34）。甲案把「开始录制」提到预览态，这两条第一次出现在零基础用户的
 *    第一眼画面上（规则 15.1 同一个可见性域），所以同批必修。
 *
 * 🔴 为什么手写混色与亮度而不是 `getComputedStyle`：jsdom **不解析 `color-mix()`**，
 * 在 DOM 上查这两条会静默拿到空值 = 假绿（AGENTS 23：新守卫必须先喂反例）。
 * 这里按 CSS 规范自己算：`in srgb` = 对 sRGB 分量线性插值，alpha 同插；亮度用
 * WCAG 相对亮度；文字先合成到玻璃底再比值。
 * 与 `design/屏幕录制-默认整屏一步开录-甲案-设计稿.html` §5.1 的浏览器实测**两套算法
 * 独立**，数字对不上即有一边错。
 *
 * 底色口径：玻璃 `--shot-bar-bg` 是 alpha 0.9–0.94 的近不透明层，这里按其**自身 rgb**
 * 当底（与设计稿同口径）。这对浅色主题是上限——真机压在深色画面上底会更暗、比值更低，
 * 所以「过」不等于真机一定过，「不过」则一定不过。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const themeSrc = readFileSync(join(process.cwd(), "src/styles/theme.css"), "utf8");
const recselSrc = readFileSync(join(process.cwd(), "src/styles/recsel.css"), "utf8");

const THEMES = ["ocean-dark", "midnight", "ocean", "forest", "blossom", "dawn"] as const;
const AA_TEXT = 4.5; // 两条都是 11–12px 小字，没有大字豁免（≥24px / ≥18.66px 粗体）

type Rgb = { r: number; g: number; b: number; a: number };

/** 按大括号配对切顶层规则；返回 `{selector, decls[]}`，`@media` 一类的块整体跳过。 */
function topLevelRules(cssRaw: string) {
  // 🔴 先剥注释：本仓 CSS 的令牌行上方常带一行说明（`/* 控件玻璃… */ --shot-bar-bg: …`），
  // 不剥的话分号切片后那条声明以 `/*` 开头，`^(--x)` 匹配不上 = 令牌被静默丢掉
  // （2026-10-10 第一版就是这么丢了 --shot-bar-bg）。浏览器 CSSOM 本来就忽略注释，
  // 所以设计稿 §5.1 的浏览器读数不受影响——两边对不上时先怀疑这里。
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: { selector: string; decls: string[] }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const selector = css.slice(i, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      const ch = css[close];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      close++;
    }
    const body = css.slice(open + 1, close - 1);
    if (body.includes("{")) {
      i = close; // 嵌套（@media/@supports）：本守卫不需要，跳过
      continue;
    }
    const cleanSel = selector.trim();
    if (cleanSel && !cleanSel.startsWith("@")) {
      rules.push({ selector: cleanSel, decls: body.split(";").map((d) => d.trim()).filter(Boolean) });
    }
    i = close;
  }
  return rules;
}

/** 变量表：先 :root（含 `:root, [data-theme=…]` 这类共享块），再叠本主题块。 */
function tokensForTheme(theme: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rule of topLevelRules(themeSrc)) {
    const parts = rule.selector.split(",").map((s) => s.trim());
    const applies = parts.includes(":root") || parts.includes(`[data-theme="${theme}"]`);
    if (!applies) continue;
    for (const d of rule.decls) {
      const m = d.match(/^(--[\w-]+)\s*:\s*([\s\S]+)$/);
      if (m) map[m[1]] = m[2].trim();
    }
  }
  return map;
}

/** `var(--x)` / `var(--x, fallback)` 展开；嵌套深度上限防自引用死循环。 */
function resolveVars(expr: string, tokens: Record<string, string>, depth = 0): string {
  if (depth > 8) throw new Error(`var 嵌套过深：${expr}`);
  const m = expr.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (!m) {
    // 内嵌 var()（如 color-mix 的参数位）：逐个替换后重试
    const inlined = expr.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fb) => {
      const v = tokens[name];
      if (v !== undefined) return v;
      if (fb !== undefined) return fb.trim();
      throw new Error(`未定义的变量 ${name}（表达式 ${expr}）`);
    });
    if (inlined !== expr) return resolveVars(inlined.trim(), tokens, depth + 1);
    return expr;
  }
  const v = tokens[m[1]];
  if (v === undefined) {
    if (m[2] === undefined) throw new Error(`主题里没有 ${m[1]}`);
    return resolveVars(m[2].trim(), tokens, depth + 1);
  }
  return resolveVars(v, tokens, depth + 1);
}

function parseColor(expr: string): Rgb {
  const s = expr.trim();
  if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, a: 0 }; // CSS 规范里的关键字色
  let m = s.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (m) {
    const h = m[1];
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const v = parseInt(full, 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 };
  }
  m = s.match(/^rgba?\(([^)]*)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  throw new Error(`解析不了的色值：${s}`);
}

/**
 * 求值：支持 `color-mix(in srgb, A P%, B)`（可嵌套）、`var()` 链、hex/rgb(a)。
 * `transparent` 按 sRGB 规范是 rgba(0,0,0,0)。
 */
function evalColor(expr: string, tokens: Record<string, string>): Rgb {
  const flat = resolveVars(expr, tokens);
  const m = flat.match(/^color-mix\(\s*in\s+srgb\s*,\s*(.+)\s*\)$/i);
  if (!m) return parseColor(flat);
  const args = m[1];
  // 按顶层逗号劈两段（第二段可能自带 color-mix，用括号深度切）
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      cut = i;
      break;
    }
  }
  if (cut < 0) throw new Error(`color-mix 参数不合法：${flat}`);
  const left = args.slice(0, cut).trim();
  const right = args.slice(cut + 1).trim();
  const pm = left.match(/^(.*?)\s+([\d.]+)%$/);
  if (!pm) throw new Error(`color-mix 缺百分比：${left}`);
  const pct = Number(pm[2]) / 100;
  const a = evalColor(pm[1].trim(), tokens);
  // 第二段可省略百分比（= 补数）
  const pm2 = right.match(/^(.*?)\s+([\d.]+)%$/);
  const b = evalColor(pm2 ? pm2[1].trim() : right, tokens);
  // 🔴 css-color-4 的插值是**预乘 alpha** 的：`color-mix(… 40%, transparent)` 得到的是
  // 「原色 + alpha 0.4」，不是「原色×0.4 + 黑×0.6」。按非预乘算会把关闭态从 3.30 错算成
  // 1.41（2026-10-10 与设计稿 §5.1 的浏览器实测对表时才暴露——两套算法互证的意义就在这）
  const aMix = pct * a.a + (1 - pct) * b.a;
  const mix = (ca: number, cb: number) =>
    aMix === 0 ? 0 : (pct * a.a * ca + (1 - pct) * b.a * cb) / aMix;
  return { r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b), a: aMix };
}

function relLum(c: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** 半透明前景合成到不透明底（前景 alpha < 1 时必须先合成，否则弱态会被高估成满对比）。 */
function over(fg: Rgb, bg: Rgb): Rgb {
  const mix = (x: number, y: number) => fg.a * x + (1 - fg.a) * y;
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function ratioOnGlass(fgExpr: string, tokens: Record<string, string>): number {
  const bgRaw = evalColor(tokens["--shot-bar-bg"], tokens);
  if (bgRaw.a <= 0.85) throw new Error(`玻璃底 alpha=${bgRaw.a} 不是近不透明，口径要重定`);
  const bg: Rgb = { ...bgRaw, a: 1 };
  const fg = evalColor(fgExpr, tokens);
  const c = over(fg, bg);
  const L1 = relLum(c);
  const L2 = relLum(bg);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 从 recsel.css 里取某条选择器的 `color` 声明（取不到 = 类名或属性被改走，守卫该红）。 */
function colorDecl(selector: string): string {
  const key = selector.replace(/\s+/g, "");
  for (const rule of topLevelRules(recselSrc)) {
    // 逗号分组选择器（`.a, .b { color: … }`）也要能命中——2026-10-10 审查批里
    // `.rec-count-cancel, .rec-count-target` 就是这么写的，按整串比对会漏。
    const hits = rule.selector.split(",").some((p) => p.replace(/\s+/g, "") === key);
    if (!hits) continue;
    const d = rule.decls.find((x) => /^color\s*:/.test(x));
    if (d) return d.replace(/^color\s*:/, "").trim();
  }
  throw new Error(`recsel.css 里找不到 ${selector} 的 color 声明`);
}

describe("录屏玻璃条字色在 6 个主题下都要过 AA", () => {
  const link = colorDecl(".rec-glass-lnk");
  const off = colorDecl(".rec-snd.off");

  it("四条声明都取到了（类名/属性被改走时这条会红，而不是静默空跑）", () => {
    for (const sel of [".rec-glass-lnk", ".rec-glass-lnk:hover", ".rec-snd.off", ".rec-seg button"]) {
      expect(colorDecl(sel).length).toBeGreaterThan(0);
    }
  });

  it.each(THEMES)("「✕ 退出」链接字 / 玻璃底 ≥ 4.5（%s）", (theme) => {
    const r = ratioOnGlass(link, tokensForTheme(theme));
    expect(r).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(THEMES)("链接字 hover 态 / 玻璃底 ≥ 4.5（%s）", (theme) => {
    const r = ratioOnGlass(colorDecl(".rec-glass-lnk:hover"), tokensForTheme(theme));
    expect(r).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(THEMES)("音源关闭态弱字 / 玻璃底 ≥ 4.5（%s）", (theme) => {
    const r = ratioOnGlass(off, tokensForTheme(theme));
    expect(r).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // 这条现网本来就过（最差 4.67 / 樱），钉住它是漂移守卫：以后调弱态透明度别把它调穿
  it.each(THEMES)("画质档未选中字 / 玻璃底 ≥ 4.5（%s）", (theme) => {
    const r = ratioOnGlass(colorDecl(".rec-seg button"), tokensForTheme(theme));
    expect(r).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("反例自检：裸 var(--accent) 当链接字必须判不过（防这条守卫本身失效）", () => {
    const bad = THEMES.map((t) => ratioOnGlass("var(--accent)", tokensForTheme(t)));
    expect(bad.some((r) => r < AA_TEXT)).toBe(true);
  });

  it("反例自检：40% 弱字必须判不过（同上）", () => {
    const bad = THEMES.map((t) =>
      ratioOnGlass("color-mix(in srgb, var(--shot-bar-text) 40%, transparent)", tokensForTheme(t)),
    );
    expect(bad.every((r) => r < AA_TEXT)).toBe(true);
  });
});

/**
 * 2026-10-10 上线前审查（`$impeccable critique`）补的两组：
 * ① 这一批改新增的文字/底色对，**必须**走同一把尺子（读数即控制、倒计时玻璃胶囊、错误句）；
 *    尤其倒计时那颗「取消」——改前是 `#fff` 压在 rgba(10,14,24,.28) 的用户桌面上，
 *    本守卫原来的口径只管玻璃条，那一对在两次横扫里谁都没量过，现在给它玻璃底后并入扫描域。
 * ② `.rec-seg` 的 `overflow:hidden` 会把四档的焦点环整圈裁掉（WCAG 2.2 AA / 2.4.7）。
 *    焦点可见性不是对比度，量不出来，只能用静态守卫钉：谁把这句加回来谁变红。
 */
describe("审查后新增的字色对同样要过 AA；画质档不许再用 overflow 裁焦点环", () => {
  const NEW_PAIRS = [
    ".rec-target-lnk", // 读数即控制（常态字）
    ".rec-target-lnk:hover",
    ".rec-target-lnk .rec-swap", // 「改录整屏」后缀
    ".rec-count-cancel", // 倒计时的鼠标逃生口
    ".rec-count-target", // 倒计时里的读数
    ".rec-err", // 「⚠ 没能开始录制」
  ] as const;

  it.each(NEW_PAIRS)("%s / 玻璃底 ≥ 4.5", (sel) => {
    const decl = colorDecl(sel);
    for (const theme of THEMES) {
      // 第二个参数是断言消息：不通过时直接把比值打出来，免得再来一轮取证
      expect(ratioOnGlass(decl, tokensForTheme(theme)), `${sel} @ ${theme}`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });

  it("反例自检：25% 的危险色弱档必须判不过（防这批新行本身失效）", () => {
    const bad = THEMES.map((t) =>
      ratioOnGlass("color-mix(in srgb, var(--danger) 25%, transparent)", tokensForTheme(t)),
    );
    expect(bad.some((r) => r < AA_TEXT)).toBe(true);
  });

  it(".rec-seg 不得声明 overflow（hidden 会裁掉 :focus-visible 的 outline）", () => {
    const rules = topLevelRules(recselSrc).filter(
      (r) => r.selector.replace(/\s+/g, "") === ".rec-seg",
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.decls.some((d) => /^overflow[\w-]*\s*:\s*hidden/.test(d))).toBe(false);
    }
  });
});
