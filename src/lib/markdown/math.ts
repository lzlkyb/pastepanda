/**
 * 数学公式（KaTeX）——源码保护与回填。
 *
 * 为什么是「解析前抽走 → 消毒后回填」而不是渲染后扫 DOM：
 * ① marked 会先吃掉公式里的 Markdown 字符——`$a*b*c$` 的 `*` 变 <em>、
 *    `$x^{a}_{b}$` 的 `_` 被吞，等 DOM 生成后公式已经残了，扫不到完整源码；
 * ② 回填放在 DOMPurify **之后**：KaTeX 的输出（MathML + span 结构）不必
 *    过消毒白名单，同时它自身 `trust:false / throwOnError:false` 是安全构造，
 *    只产标签不执行内容——与 mermaid 回填走同一个信任模型。
 *
 * 边界判据（防把价格当公式，pandoc 同款思路）：
 * - 行内 `$…$` 不跨行；内容不能以空白开头或结尾（"cost $5 and $10" 的
 *   "5 and " 含空格 → 拒）；收尾 `$` 后跟数字或 `$` → 拒（"$5-$10"、"$$$"）。
 * - `\$` 是字面量；围栏代码块、缩进 ≥4 空格的行、行内代码 span 里不做识别。
 * - 原文已含占位符前缀时整体放弃（防止回填把用户文字误换成公式）。
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import { escapeHtml } from "./html";

export interface MathSpan {
  /** 占位符（回填按它替换；防撞与唯一性见 PH_PREFIX / ph 的注释） */
  ph: string;
  /** TeX 源码（未经 Markdown 解析的原文） */
  tex: string;
  /** true = `$$…$$` 块级；false = `$…$` 行内 */
  display: boolean;
}

/**
 * 占位符 = 前缀 + 序号 + "qZ7" 终结符。
 * 终结符保证 ph(1) 不可能是 ph(10) 的子串（"…71qZ7" vs "…710qZ7"），
 * 回填的逐字替换才不会把第 11 个之后的占位符劈坏——11 个公式以上的文档
 * 必踩，见 math.test.ts 的回归用例。
 */
const PH_PREFIX = "PpMathZq7";

/** 行内公式收尾 `$` 的位置；三条拒判见 math.ts 文件头注释 */
function findInlineClose(src: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c === "$") {
      if (j > from && src[j - 1] === "\\") continue; // `\$` 是公式内容里的字面量
      const next = j + 1 < src.length ? src[j + 1] : "";
      if (/[0-9$]/.test(next)) return -1;
      return j;
    }
  }
  return -1;
}

/**
 * 把公式抽成占位符。
 * 返回的 text 喂给 Markdown 解析器；maths 里的 tex 原样保留，
 * 由 `restoreMathHtml` 在消毒后回填。无公式时原字符串直接返回（零开销路径）。
 */
export function extractMathSource(src: string): { text: string; maths: MathSpan[] } {
  const maths: MathSpan[] = [];
  if (!src.includes("$") || src.includes(PH_PREFIX)) return { text: src, maths };

  let out = "";
  let i = 0;
  const n = src.length;

  const emit = (tex: string, display: boolean) => {
    const ph = `${PH_PREFIX}${maths.length}qZ7`;
    maths.push({ ph, tex, display });
    out += ph;
  };
  const lineEndOf = (p: number): number => {
    const nl = src.indexOf("\n", p);
    return nl === -1 ? n : nl;
  };
  const nextLineStart = (p: number): number => {
    const end = lineEndOf(p);
    return end < n ? end + 1 : n;
  };

  while (i < n) {
    const atLineStart = i === 0 || src[i - 1] === "\n";
    const rest = src.slice(i);

    if (atLineStart) {
      // 缩进代码块（≥4 空格 / Tab）：整行原样——占位符漏进代码块比不渲染公式更糟
      if (/^[ \t]{4,}/.test(rest)) {
        const end = lineEndOf(i);
        out += src.slice(i, end);
        i = end;
        continue;
      }
      // 围栏代码块（``` / ~~~）：开行到闭行整段原样
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(rest);
      if (fence) {
        const closer = new RegExp(`^ {0,3}\\${fence[1][0]}{3,}`);
        let p = nextLineStart(i);
        let end = n;
        while (p < n) {
          if (closer.test(src.slice(p))) {
            end = lineEndOf(p);
            break;
          }
          p = nextLineStart(p);
        }
        out += src.slice(i, end);
        i = end;
        continue;
      }
    }

    const ch = src[i];

    // 转义 `\$`：字面量，两个字符一起跳过
    if (ch === "\\" && src[i + 1] === "$") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }

    // 行内代码 span（CommonMark 等长反引号对，限同行）：原样
    if (ch === "`") {
      const run = /^`+/.exec(rest)![0].length;
      let p = i + run;
      let close = -1;
      while (p < n && src[p] !== "\n") {
        if (src[p] === "`") {
          const r = /^`+/.exec(src.slice(p))![0].length;
          if (r === run) {
            close = p;
            break;
          }
          p += r;
        } else {
          p += 1;
        }
      }
      if (close !== -1) {
        out += src.slice(i, close + run);
        i = close + run;
        continue;
      }
      out += ch; // 未闭合：当普通字符
      i += 1;
      continue;
    }

    if (ch === "$") {
      const prev = i > 0 ? src[i - 1] : "";
      // 块级 `$$…$$`（可跨行）
      if (src[i + 1] === "$" && prev !== "$") {
        const close = src.indexOf("$$", i + 2);
        const tex = close === -1 ? "" : src.slice(i + 2, close);
        if (close !== -1 && tex.trim()) {
          emit(tex, true);
          i = close + 2;
          continue;
        }
        out += "$$";
        i += 2;
        continue;
      }
      // 行内 `$…$`
      if (prev !== "$" && prev !== "\\") {
        const close = findInlineClose(src, i + 1);
        if (close !== -1) {
          const tex = src.slice(i + 1, close);
          // 内容不能以空白开头/结尾（见文件头判据）
          if (tex && !/\s/.test(tex[0]) && !/\s/.test(tex[tex.length - 1])) {
            emit(tex, false);
            i = close + 1;
            continue;
          }
        }
      }
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { text: out, maths };
}

/**
 * 把占位符回填为 KaTeX 渲染结果。
 * `throwOnError:false`：非法 TeX 渲染成红色源码而不是抛异常（与竞品一致的反馈）；
 * 外层 try/catch 兜住 KaTeX 自身的意外抛错，绝不阻断整篇文档渲染。
 * 用 split/join 而不是 String.replace：替换串里的 `$&`/`$'` 会被当替换模式解释。
 */
export function restoreMathHtml(html: string, maths: MathSpan[]): string {
  if (maths.length === 0) return html;
  let out = html;
  for (const m of maths) {
    let piece: string;
    try {
      piece = katex.renderToString(m.tex, {
        displayMode: m.display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
    } catch {
      piece = `<span class="md-math-error">${escapeHtml(m.tex)}</span>`;
    }
    out = out.split(m.ph).join(piece);
  }
  return out;
}
