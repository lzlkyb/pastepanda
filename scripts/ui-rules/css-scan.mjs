/**
 * CSS 侧扫描（postcss AST，不是正则）。
 *
 * 用 AST 而不是 grep 的原因：需要 (1) 精确行号、(2) 区分「属性声明」与「值里的巧合」
 * ——比如 `transition: .2s` 后面的 `.2s` 被正则当成类名之类、
 * (3) 拿到同一条规则里的兄弟声明（V6 要判断「彩色底 + 灰字」必须同时看到两个声明）。
 */
import postcss from "postcss";
import {
  DURATIONS,
  RADII,
  RADIUS_GEOMETRY,
  FONT_SIZES,
  SPACINGS,
  COLOR_NAME_VARS,
  GRAY_TEXT_TOKENS,
  COLORED_BG_PREFIXES,
  FONT_BLACKLIST,
  LEFT_BAR_MIN_PX,
  LEFT_BAR_SEMANTIC,
} from "./rules.mjs";

const num = (n) => Number(n);

/** 提取值里所有 `<n>px` */
function pxValues(value) {
  const out = [];
  const re = /(-?\d*\.?\d+)px\b/g;
  let m;
  while ((m = re.exec(value)) !== null) out.push({ v: num(m[1]), raw: m[0] });
  return out;
}

/**
 * V8.1 用：解析 `border-radius` 的各个角数值（px），保留裸 `0`。
 *
 * 🔴 不能直接复用 pxValues：`0 8px 8px 0` 里的两个裸 `0` 没有 px 单位，
 * pxValues 只会返回 `[8, 8]` —— 于是判定会以为「四角皆非 0」，
 * 把「左直角」这条**最重要的豁免**判反，正确的引用块写法会被报成 AI 味。
 * 这个 bug 正是 self-test 的 clean.css 抓出来的（2026-09-25）。
 *
 * @returns {number[]|null} null = 含百分比/var()/calc() 等判不了的形式，调用方应放行
 */
function cornerRadii(value) {
  const out = [];
  for (const tok of String(value).trim().split(/[\s/]+/).filter(Boolean)) {
    const m = /^(-?\d*\.?\d+)(px)?$/.exec(tok);
    if (!m) return null;
    out.push(num(m[1]));
  }
  return out.length ? out : null;
}

/** 提取值里所有时间量（毫秒归一到 ms）。注意 `0s` 不算动效 */
function timeValues(value) {
  const out = [];
  const re = /(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    const v = m[2] === "s" ? num(m[1]) * 1000 : num(m[1]);
    out.push({ ms: v, raw: m[0] });
  }
  return out;
}

function hexIsNeutral(hex) {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  if ([r, g, b].some(Number.isNaN)) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) < 18;
}

function rgbIsNeutral(value) {
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
  if (!m) return false;
  const [r, g, b] = [1, 2, 3].map((i) => num(m[i]));
  return Math.max(r, g, b) - Math.min(r, g, b) < 18;
}

function stripUrlFns(value) {
  return value.replace(/url\([^)]*\)/g, "url()");
}

const hasHex = (value) => /#[0-9a-fA-F]{3,8}\b/.test(stripUrlFns(value));
const hasNumericRgb = (value) => /(?:rgba?|hsla?)\(\s*[\d.]/.test(value);

/** V6：这个背景值算不算「彩色底」 */
function isColoredBg(value) {
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (COLORED_BG_PREFIXES.some((p) => m[1].startsWith(p))) return true;
    if (COLOR_NAME_VARS.test(m[1])) return true;
  }
  for (const m of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) if (!hexIsNeutral(m[0])) return true;
  if (/(?:rgba?|hsla?)\(/.test(value) && !rgbIsNeutral(value) && hasNumericRgb(value)) return true;
  return false;
}

/**
 * 中性色是否落在「被冲淡的灰」这一段里。
 *
 * 🔴 不能只判「r=g=b」：`#fff` 也是中性色，但**彩色底上的白字是正确的**（那是前景，
 * 不是被冲淡的次要文字）。2026-09-22 实测：不加这段，V6 会把 200+ 处
 * `background: var(--accent-solid); color: #fff` 全部误报成违规。
 *
 * 近白（≥235）是刻意的前景，近黑（≤40）是刻意的深色底/描边，都不算「洗成脏灰」。
 */
function isMutedNeutral(value) {
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
  if (m) {
    const [r, g, b] = [1, 2, 3].map((i) => num(m[i]));
    const max = Math.max(r, g, b);
    return max - Math.min(r, g, b) < 18 && max > 40 && max < 235;
  }
  for (const hex of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    let h = hex[0].replace(/^#/, "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6) continue;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if ([r, g, b].some(Number.isNaN)) continue;
    const max = Math.max(r, g, b);
    if (max - Math.min(r, g, b) < 18 && max > 40 && max < 235) return true;
  }
  return false;
}

/** V6：这个前景值算不算「被冲淡的灰」 */
function isGrayText(value) {
  // 语义灰变量：直接点名，不靠色值推
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) if (GRAY_TEXT_TOKENS.includes(m[1])) return true;
  return isMutedNeutral(value);
}

/** 本文件内定义的动效 token（`--dur-*: 150ms`）——跨文件引用无法核值，只能核本文件 */
function localDurationTokens(root) {
  const map = new Map();
  root.walkDecls((d) => {
    if (!/^--/.test(d.prop)) return;
    if (!/(dur|duration|motion|anim|time)/i.test(d.prop)) return;
    const t = timeValues(d.value);
    if (t.length) map.set(d.prop, t[0].ms);
  });
  return map;
}

/**
 * @param {string} text
 * @param {(line:number)=>boolean} inScopeLine
 * @param {(line:number)=>boolean} hasAllow 已通过豁免注释的行
 * @returns {{findings:Array, stats:object}}
 */
export function scanCss(text, inScopeLine, hasAllow) {
  const root = postcss.parse(text);
  const findings = [];
  const stats = { border: 0, spacingOff: 0 };
  const durTokens = localDurationTokens(root);

  const push = (rule, node, snippet) => {
    const line = node.source?.start?.line ?? 0;
    if (!inScopeLine(line)) return;
    if (hasAllow(line)) return;
    findings.push({ rule, line, snippet });
  };

  /** 动效时长核值：显式值 + 本文件 token 引用 */
  const checkTiming = (decl, kinds) => {
    const value = decl.value;
    // 1) 显式值（同一行里重复出现的同一时长只报一次——`cubic-bezier` 里没有时间单位，
    //    但 `transition: a 100ms, b 100ms` 这种会让同一条问题印三遍，人就不看了）
    const seenTimes = new Set();
    for (const t of timeValues(value)) {
      if (t.ms === 0 || seenTimes.has(t.ms)) continue;
      seenTimes.add(t.ms);
      // animation 的 ≥1s 属于环境动画（SkinScene 2.6–16s 那一类），文档明确说不参与 U2
      if (kinds.includes("animation") && t.ms >= 1000) continue;
      if (!DURATIONS.includes(t.ms)) push("U2", decl, `${decl.prop}: ${value}  → ${t.raw}`);
    }
    // 2) 本文件 token 引用
    const seenVars = new Set();
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = m[1];
      if (seenVars.has(name) || !durTokens.has(name)) continue;
      seenVars.add(name);
      const ms = durTokens.get(name);
      if (ms === 0 || DURATIONS.includes(ms)) continue;
      if (kinds.includes("animation") && ms >= 1000) continue;
      push("U2token", decl, `${decl.prop}: ${value}  → ${name} = ${ms}ms`);
    }
    // 3) 曲线
    for (const m of value.matchAll(/cubic-bezier\([^)]*\)/g)) {
      const norm = m[0].replace(/\s+/g, " ").replace(/,\s*/g, ", ");
      if (norm === "cubic-bezier(0.2, 0, 0, 1)" || norm === "cubic-bezier(0.05, 0.7, 0.1, 1)") continue;
      push("U2ease", decl, `${decl.prop}: ${m[0]}`);
    }
    if (/\bsteps\(/.test(value)) push("U2ease", decl, `${decl.prop}: ${value}`);
    // 4) 弹簧（U2 2026-09-25 修订）：CSS 侧弹簧只许走 --ease-spring 令牌；
    //    裸写 linear(...) 采样 = 自定义弹簧曲线，曲线数失控的口子。
    if (/(^|[^-\w])linear\(/.test(value)) push("U2spring", decl, `${decl.prop}: ${value}`);
  };

  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    const value = decl.value;
    const isTokenDef = prop.startsWith("--");

    // ── U2 动效 ──────────────────────────────────────────────
    if (!isTokenDef && /^transition(-|$)/.test(prop)) checkTiming(decl, ["transition"]);
    if (!isTokenDef && /^animation(-|$)/.test(prop)) checkTiming(decl, ["animation"]);
    if (isTokenDef && durTokens.has(decl.prop)) {
      const ms = durTokens.get(decl.prop);
      if (ms !== 0 && !DURATIONS.includes(ms)) {
        push("U2token", decl, `${decl.prop}: ${value}（token 是扩散源，它错一次所有引用一起错）`);
      }
    }
    if (isTokenDef) return; // token 定义处放行 U5/V2/V3/U6——它本来就是「建尺子」的地方

    // ── U5 尺度 ──────────────────────────────────────────────
    if (/^border-radius$|^border-(top|bottom|left|right)(-(start|end))?-radius$/.test(prop)) {
      for (const { v, raw } of pxValues(value)) {
        if (RADIUS_GEOMETRY.includes(raw) || RADII.includes(v)) continue;
        if (v >= 100) continue; // 999px 起算的胶囊写法
        push("U5radius", decl, `${prop}: ${value}  → ${raw}`);
      }
    }
    if (prop === "font-size") {
      for (const { v, raw } of pxValues(value)) {
        if (!FONT_SIZES.includes(v)) push("U5font", decl, `${prop}: ${value}  → ${raw}`);
      }
    }
    if (/^(gap|row-gap|column-gap)$/.test(prop) || /^(padding|margin)(-|$)/.test(prop)) {
      const off = pxValues(value).filter(({ v }) => v !== 0 && !SPACINGS.includes(v));
      if (off.length) {
        // 🔴 计数必须跟着 `push` 的判定走（作用域 + `ui-rule-ok` 豁免），不能自己先 ++。
        // 否则写了理由豁免的那一行明细不出来、却仍算进总数：报告写着「U5 间距不在表里
        // 3 处」而明细只有 2 条（实测 3 处里正好 1 处是豁免的），读的人只会当成漏报。
        const before = findings.length;
        push("U5space", decl, `${prop}: ${value}  → ${off.map((o) => o.raw).join(" ")}`);
        if (findings.length > before) stats.spacingOff++;
      }
    }

    // ── V2 阴影 ──────────────────────────────────────────────
    if (prop === "box-shadow" && value.trim() !== "none" && !/var\(\s*--/.test(value)) {
      push("V2", decl, `${prop}: ${value}`);
    }

    // ── V8.2 字体黑名单 ──────────────────────────────────────
    // 生成式设计缺约束时的默认字体（Inter/Roboto/Arial/Fraunces）。
    // 本项目走系统字体栈，实测 0 处；本条是防回归的预防性判据。
    if (prop === "font-family" && FONT_BLACKLIST.test(value)) {
      push("V8font", decl, `${prop}: ${value}`);
    }

    // ── V3 硬编码颜色 ────────────────────────────────────────
    if (hasHex(value)) {
      push("V3", decl, `${prop}: ${value}`);
    } else if (hasNumericRgb(value)) {
      push("V3rgb", decl, `${prop}: ${value}`);
    }

    // ── U6 色名变量 ──────────────────────────────────────────
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (COLOR_NAME_VARS.test(m[1])) push("U6", decl, `${prop}: ${value}  → var(${m[1]})`);
    }

    // ── V1 边框（计数型，不逐行报） ──────────────────────────
    //
    // 🔴 与 U5space 同口径：计数必须跟着 `ui-rule-ok` 豁免走（理由见上面 U5space 那段）。
    //    V1 此前直接 `stats.border++`，于是**写了理由也照样计数** —— 而文档的判定句是
    //    「说不出理由 → 违反」，等于把「边框是最后一手」读成了「一律不许加边框」。
    //    实测 2026-09-26：本次改动的 13 处里全是按钮 / 输入框 / 分段控件 / 侧栏分割线，
    //    没有一条是「用间距或背景色就能替代」的，它们全说得出理由。
    if (/^border(-(top|bottom|left|right|inline|block|start|end))?$/.test(prop) && /\bsolid\b|\b\d+px\b/.test(value)) {
      const line = decl.source?.start?.line ?? 0;
      if (inScopeLine(line) && !hasAllow(line)) stats.border++;
    }
  });

  // ── V6 彩色底 + 灰字（需要同一条规则里的兄弟声明，所以在 rule 层做） ──
  root.walkRules((rule) => {
    const decls = (rule.nodes || []).filter((n) => n.type === "decl");
    const bg = decls.find((d) => /^background(-color)?$/.test(d.prop.toLowerCase()));
    const fg = decls.find((d) => d.prop.toLowerCase() === "color");
    if (!bg || !fg) return;
    const bgLine = bg.source?.start?.line ?? 0;
    const fgLine = fg.source?.start?.line ?? 0;
    if (!inScopeLine(bgLine) && !inScopeLine(fgLine)) return;
    if (hasAllow(fgLine) || hasAllow(bgLine)) return;
    if (!isColoredBg(bg.value) || !isGrayText(fg.value)) return;
    findings.push({
      rule: "V6",
      line: fgLine,
      snippet: `${rule.selector} { background: ${bg.value}; color: ${fg.value} }`,
    });
  });

  // ── V8.1 四角圆角 + 左侧色条（同 V6，需要兄弟声明，所以在 rule 层做） ──
  //
  // 🔴 判据必须贴着 baoyu 原文「containers with **rounded corners** and left-border
  // accent color」。三个放行条件各自防一类误报：
  //   ① 选择器是引用块/警示条 → 语义性用法（LEFT_BAR_SEMANTIC 逐条给了理由）
  //   ② 圆角里有 0（`0 8px 8px 0`）→ 左侧直角，这恰恰是色条的正确写法
  //   ③ 色条宽度 < 2px 或颜色是中性灰 → 那是普通的 1px 分隔线，V1 管它
  root.walkRules((rule) => {
    if (LEFT_BAR_SEMANTIC.some(([re]) => re.test(rule.selector))) return;
    const decls = (rule.nodes || []).filter((n) => n.type === "decl");

    // ① 四角皆非 0
    const radius = decls.find((d) => d.prop.toLowerCase() === "border-radius");
    if (!radius) return;
    const radii = cornerRadii(radius.value);
    if (!radii || radii.some((v) => v === 0)) return;

    // ② 左侧色条：≥2px 且彩色
    const blDecls = decls.filter((d) =>
      /^border-left(-(width|color|style))?$/.test(d.prop.toLowerCase()),
    );
    if (!blDecls.length) return;
    const widths = blDecls.flatMap((d) => pxValues(String(d.value)).map((p) => p.v));
    if (!widths.some((v) => v >= LEFT_BAR_MIN_PX)) return;
    if (!blDecls.some((d) => isColoredBg(String(d.value)))) return;

    const line = blDecls[0].source?.start?.line ?? 0;
    const radiusLine = radius.source?.start?.line ?? 0;
    if (!inScopeLine(line) && !inScopeLine(radiusLine)) return;
    if (hasAllow(line) || hasAllow(radiusLine)) return;
    findings.push({
      rule: "V8leftbar",
      line,
      snippet: `${rule.selector} { border-radius: ${radius.value}; ${blDecls
        .map((d) => `${d.prop}: ${d.value}`)
        .join("; ")} }`,
    });
  });

  return { findings, stats };
}
