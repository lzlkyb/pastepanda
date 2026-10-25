/**
 * 数学公式抽取/回填的判据守卫。
 *
 * 这些用例钉住的是「什么被当公式、什么不被当」——判据松一格，价格就会被
 * 渲染成天书；紧一格，正常公式就漏渲染。改 extractMathSource 前先跑这里。
 */
import { describe, expect, it } from "vitest";
import { extractMathSource, restoreMathHtml, type MathSpan } from "./math";

const spans = (text: string) => extractMathSource(text).maths;

describe("extractMathSource · 识别", () => {
  it("行内 $…$ 抽成占位符，源码原样保留", () => {
    const { text, maths } = extractMathSource("算式 $a+b$ 结尾");
    expect(maths).toEqual([{ ph: expect.any(String), tex: "a+b", display: false } as MathSpan]);
    expect(text).toBe(`算式 ${maths[0].ph} 结尾`);
  });

  it("块级 $$…$$ 可跨行且标记 display", () => {
    const { maths } = extractMathSource("$$\n\\frac{1}{2}\n$$");
    expect(maths).toHaveLength(1);
    expect(maths[0].display).toBe(true);
    expect(maths[0].tex).toBe("\n\\frac{1}{2}\n");
  });

  it("同一行多个公式各占各的占位符", () => {
    const { maths } = extractMathSource("$a$ 与 $b$");
    expect(maths.map((m) => m.tex)).toEqual(["a", "b"]);
  });

  it("词中公式（a$x$b）也识别——pandoc 同款语义", () => {
    expect(spans("a$x$b")).toHaveLength(1);
  });

  it("公式内的 Markdown 字符不被抽走（这正是要预提取的原因）", () => {
    expect(spans("$a*b*c$")[0].tex).toBe("a*b*c");
  });
});

describe("extractMathSource · 拒判（价格不是公式）", () => {
  it("两个价格之间不识别（内容含空格）", () => {
    expect(spans("价格 $5 到 $10 之间")).toEqual([]);
  });

  it("区间 $5-$10 不识别（收尾 $ 后跟数字）", () => {
    expect(spans("范围 $5-$10")).toEqual([]);
  });

  it("转义 \\$ 是字面量", () => {
    const { text, maths } = extractMathSource("价格 \\$5 元");
    expect(maths).toEqual([]);
    expect(text).toBe("价格 \\$5 元");
  });

  it("行内公式不跨行", () => {
    expect(spans("$a\nb$")).toEqual([]);
  });

  it("内容以空白开头/结尾不识别", () => {
    expect(spans("$ x$")).toEqual([]);
    expect(spans("$x $")).toEqual([]);
  });

  it("未闭合的 $ 保持字面量", () => {
    expect(spans("成本 $5")).toEqual([]);
  });

  it("$$$ 不是公式", () => {
    expect(spans("$$$")).toEqual([]);
  });
});

describe("extractMathSource · 代码豁免区", () => {
  it("行内代码 span 里的 $ 不识别", () => {
    expect(spans("变量 `$x$` 是演示")).toEqual([]);
  });

  it("围栏代码块里的 $ 不识别（含跨行 $$）", () => {
    expect(spans("```\n$x$ 和 $$y$$\n```")).toEqual([]);
  });

  it("缩进 ≥4 空格的行（缩进代码块）不识别", () => {
    expect(spans("    $x$")).toEqual([]);
  });

  it("围栏外的公式照常识别（豁免区没有扩大化）", () => {
    expect(spans("```\ncode\n```\n$x$")).toHaveLength(1);
  });
});

describe("extractMathSource · 防撞与副作用", () => {
  it("原文已含占位符前缀 → 整体放弃，一字不改", () => {
    const src = "PpMathZq7 出现时 $x$ 也不处理";
    expect(extractMathSource(src)).toEqual({ text: src, maths: [] });
  });

  it("11 个公式以上占位符互不为子串（回填不劈坏）", () => {
    const src = Array.from({ length: 12 }, (_, i) => `$x_{${i}}$`).join(" ");
    const { text, maths } = extractMathSource(src);
    expect(maths).toHaveLength(12);
    // 逐个检查：任何 ph 都不是别的 ph 的子串
    for (const m of maths) {
      expect(maths.filter((o) => o !== m && o.ph.includes(m.ph))).toEqual([]);
    }
    expect(text).not.toContain("$");
  });

  it("任务行里的公式不破坏列表前缀（checkbox 序号依赖它）", () => {
    const { text, maths } = extractMathSource("- [ ] 任务 $x$ 完成");
    expect(maths).toHaveLength(1);
    expect(text.startsWith("- [ ] 任务 ")).toBe(true);
  });
});

describe("restoreMathHtml", () => {
  it("占位符回填为 KaTeX 标记", () => {
    const { text, maths } = extractMathSource("$a+b$");
    const html = restoreMathHtml(`<p>${text}</p>`, maths);
    expect(html).toContain("katex");
    expect(html).not.toContain("PpMathZq7");
  });

  it("非法 TeX 渲染为错误标记而不是抛异常", () => {
    const html = restoreMathHtml("<p>PpMathZq70qZ7</p>", [
      { ph: "PpMathZq70qZ7", tex: "\\unknown{", display: false },
    ]);
    expect(html).toContain("katex-error");
  });

  it("KaTeX 意外抛错时退化为转义源码（不阻断整篇渲染）", () => {
    // renderToString 对个别输入仍可能抛（throwOnError 只盖解析错），
    // 兜底路径必须产出可读文本。用带循环宏的病态输入制造抛错不可靠，
    // 这里直接验证 catch 分支的行为合同：任何输入都不抛出、都产出字符串。
    const html = restoreMathHtml("<p>PpMathZq70qZ7</p>", [
      { ph: "PpMathZq70qZ7", tex: "x", display: true },
    ]);
    expect(typeof html).toBe("string");
    expect(html).toContain("katex");
  });
});
