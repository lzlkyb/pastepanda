/**
 * Phase 3（P0 渲染）占位逻辑单测。
 * 验证：mermaid 代码块外壳 HTML 生成 + 主题映射（不依赖 DOM/mermaid 运行时）。
 */
import { describe, it, expect } from "vitest";
import { mermaidBlockHtml, mapMermaidTheme } from "@/lib/mermaidBlock";

describe("mermaidBlockHtml", () => {
  it("flowchart 子集：生成占位块且显示「编辑」按钮", () => {
    const html = mermaidBlockHtml("flowchart TD\nA[开始] --> B[结束]");
    expect(html).toContain("md-codeblock-mermaid");
    expect(html).toContain("md-mermaid-body");
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain("md-mermaid-edit");
  });

  it("graph 写法（横向 LR）也视为可编辑", () => {
    const html = mermaidBlockHtml("graph LR\nA-->B");
    expect(html).toContain("md-mermaid-edit");
  });

  it("非 flowchart 类型（如 sequenceDiagram）：渲染但不提供编辑入口", () => {
    const html = mermaidBlockHtml("sequenceDiagram\nA->>B: hi");
    expect(html).toContain("md-codeblock-mermaid");
    expect(html).not.toContain("md-mermaid-edit");
  });

  it("源码被 HTML 转义，杜绝注入", () => {
    const html = mermaidBlockHtml('flowchart TD\nA["<script>alert(1)</script>"] --> B');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("隐藏源码块保留，供复制/渲染/闭环读取", () => {
    const html = mermaidBlockHtml("flowchart TD\nA-->B");
    expect(html).toContain('class="md-mermaid-raw"');
    expect(html).toContain("display:none");
  });
});

describe("mapMermaidTheme", () => {
  it("6 套主题映射到 mermaid 内置主题", () => {
    expect(mapMermaidTheme("ocean-dark")).toBe("dark");
    expect(mapMermaidTheme("midnight")).toBe("dark");
    expect(mapMermaidTheme("forest")).toBe("forest");
    expect(mapMermaidTheme("ocean")).toBe("neutral");
    expect(mapMermaidTheme("blossom")).toBe("neutral");
    expect(mapMermaidTheme("dawn")).toBe("neutral");
  });

  it("未知主题回退 neutral", () => {
    expect(mapMermaidTheme("whatever")).toBe("neutral");
  });
});
