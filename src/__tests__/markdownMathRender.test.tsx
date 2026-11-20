/**
 * 数学公式走完整渲染管线（renderMarkdownHtml）的集成守卫。
 *
 * 单元判据在 lib/markdown/math.test.ts；这里钉的是「预提取 → marked →
 * DOMPurify → 回填」整条链路两件事：
 * ① 公式里的 Markdown 字符（*、_）不再被 marked 吃掉——这是选「预提取」
 *    而不是「渲染后扫 DOM」的全部理由；
 * ② 占位符能活着穿过 marked + DOMPurify，回填后不留残渣。
 */
import { describe, expect, it } from "vitest";
import { renderMarkdownHtml } from "@/lib/markdown/renderHtml";

describe("renderMarkdownHtml · 数学公式", () => {
  it("行内与块级公式都渲染为 KaTeX 标记", () => {
    const html = renderMarkdownHtml("行内 $a+b$ 与\n\n$$c = \\sqrt{2}$$\n\n结尾");
    expect(html).toContain("katex");
    expect(html).not.toContain("PpMathZq7");
    expect(html).not.toContain("$a+b$");
  });

  it("公式里的 * 与 _ 不被 marked 吃掉（预提取的设计动机）", () => {
    const html = renderMarkdownHtml("$a*b*c$ 与 $x_{i}$");
    // 若没有预提取，$a*b*c$ 会先变成 $a<em>b</em>c$，公式源码已残
    expect(html).toContain("katex");
    expect(html).not.toContain("<em>");
  });

  it("价格文本原样保留，不产生公式标记", () => {
    const html = renderMarkdownHtml("价格 $5 到 $10 之间");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5");
  });

  it("无 $ 的文档零开销路径（输出与无公式时一致）", () => {
    expect(renderMarkdownHtml("普通 **加粗** 文本")).toContain("<strong>");
  });
});
