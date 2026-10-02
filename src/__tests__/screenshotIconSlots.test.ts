/**
 * 图标位守卫（截图浮层，方案 B 设计稿 §7 乙档）。
 *
 * 钉住的不变量：
 * ① `.ic` / `.qr-ic` 这类**图标槽里必须是组件**，不许再手打 ⬡ 📌 ⚡ ▦ ✓ 这类文本字符
 *    —— 一屏四种图标语言是这轮整改的起因（D1/D2/D3）；
 * ② `.k` 那一列**只放快捷键**：翻译行原来挂的是装饰性 ⚡，而它根本没有快捷键（D5）。
 *
 * 为什么用源文件正则而不是渲染：截图窗是独立 React root + 全屏遮罩，
 * 在 jsdom 里渲染整棵树要 mock 十几个 Tauri 命令；而「下一个人在槽里打了个字符」
 * 恰恰是能在源码里一眼看出的形状，静态守卫够用且不会因运行时缺失而假绿。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const dir = resolve(root, "src/components/screenshot");

/** 图标槽的类名。`.sw` 在底部带里还有一个「颜色块」的用法，
 *  那条写的是 `className="sw" style={{...}}`（属性在 `>` 之前），本测试的正则天然不匹配。 */
const SLOT_CLASS = "(?:ic|qr-ic|sw)";

/** 从一段源码里抠出每个图标槽的内容（守卫判据也用它自检，见「守卫不是假绿」） */
function slotContentsText(src: string): string {
  const re = new RegExp(`className="${SLOT_CLASS}"\\s*>((?:[\\s\\S]{0,200}?)</span>)`);
  const m = re.exec(src);
  return m ? m[1].replace(/<\/span>$/, "").trim() : "";
}

function slotContents(file: string): { inner: string; line: number }[] {
  const src = readFileSync(resolve(dir, file), "utf8");
  const re = new RegExp(`className="${SLOT_CLASS}"\\s*>((?:[\\s\\S]{0,200}?)</span>)`, "g");
  const out: { inner: string; line: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const inner = m[1].replace(/<\/span>$/, "").trim();
    out.push({ inner, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

const tsxFiles = readdirSync(dir).filter((f) => f.endsWith(".tsx"));

describe("① 图标槽里必须是组件", () => {
  it("每个 .ic / .qr-ic 槽的内容都以 < 或 {（三元渲染组件）开头", () => {
    const bad: string[] = [];
    for (const f of tsxFiles)
      for (const { inner, line } of slotContents(f)) {
        if (!inner) continue;
        if (!/^<|^\{/.test(inner)) bad.push(`${f}:${line} → ${inner.slice(0, 30)}`);
      }
    expect(bad, `图标位手打了文本字符：${bad.join(" | ")}`).toEqual([]);
  });

  it("槽内不许出现字符串字面量（`{\"✓\"}` 与三元里的字符同样违规）", () => {
    const bad: string[] = [];
    for (const f of tsxFiles)
      for (const { inner, line } of slotContents(f)) {
        // 组件 props 的引号是合法的（`name="file-text"`），先把「= "值"」剥掉；
        // 剩下的引号只会是「把字符当内容写进槽里」——正是整改前的 `{ok ? "✓" : "⚠"}`。
        const rest = inner.replace(/=\s*"[^"]*"/g, "");
        if (rest.includes('"')) bad.push(`${f}:${line} → ${inner.slice(0, 40)}`);
      }
    expect(bad, `图标位里塞的是字符串而不是组件：${bad.join(" | ")}`).toEqual([]);
  });

  it("守卫不是假绿：16 个槽确实被扫到，且整改前的两种写法都会红灯", () => {
    const total = tsxFiles.reduce((n, f) => n + slotContents(f).length, 0);
    expect(total).toBeGreaterThanOrEqual(15);
    // 判据本身的可信度：拿整改前的真实原文喂给它
    const old = ['<span className="ic">⬡</span>', '<span className="ic">{shotToast.ok ? "✓" : "⚠"}</span>'];
    for (const s of old) {
      const inner = slotContentsText(s);
      const flagged = !/^<|^\{/.test(inner) || inner.replace(/=\s*"[^"]*"/g, "").includes('"');
      expect(flagged, `旧写法没被抓住：${s}`).toBe(true);
    }
  });

  it("出口面板十行确实各有一枚组件图标（不是空槽）", () => {
    const rows = slotContents("ResultActions.tsx");
    expect(rows.length).toBe(1); // 面板只有一处槽位写法：十行共用 ExitRow
    expect(rows[0].inner).toMatch(/^<Icon size=\{15\} \/>$/);
  });
});

describe("② .k 只放快捷键", () => {
  const src = readFileSync(resolve(dir, "ResultActions.tsx"), "utf8");

  it("出口面板里 hint= 的值一律是 Ctrl/Enter/Esc 组合键", () => {
    const hints = [...src.matchAll(/hint="([^"]+)"/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) expect(h, `hint="${h}" 不是快捷键`).toMatch(/^(Ctrl|Alt|Shift|Enter|Esc)\b/);
  });

  it("`.k` 的渲染点只有一处，且内容只可能是 hint（不接受行内字面量）", () => {
    const renders = [...src.matchAll(/className="k"\}?>((?:[\s\S]{0,60}?))</g)].map((m) => m[1].trim());
    expect(renders).toEqual(["{hint}"]);
  });
});
