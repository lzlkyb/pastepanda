/**
 * Markdown 预览锚点：heading id + 点击拦截。
 *
 * 守的是「大纲 slug」与「预览 id」同源，以及正文目录链接不再点了没反应。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { marked } from "marked";
import { resetHeadingSlugState, handleAnchorClick } from "@/lib/markdown/headingAnchor";
import "@/components/MarkdownRenderer"; // 注册 heading renderer

// 与 MarkdownRenderer.renderMarkdownHtml 同路径：每次解析前 reset
function parse(md: string): string {
  resetHeadingSlugState();
  return marked.parse(md) as string;
}

describe("Markdown heading 锚点", () => {
  beforeEach(() => {
    resetHeadingSlugState();
  });

  it("标题带 id 与 md-hanchor，重复标题去重", () => {
    const html = parse("## 安装步骤\n\n内容\n\n## 安装步骤\n\n再次\n");
    expect(html).toContain('id="安装步骤"');
    expect(html).toContain('id="安装步骤-1"');
    expect(html).toContain('class="md-hanchor"');
    expect(html).toContain('href="#安装步骤"');
  });

  it("围栏内 # 不会生成标题节点", () => {
    const html = parse("# 真\n\n```\n# 假\n```\n");
    expect(html).toContain('id="真"');
    expect(html).not.toContain('id="假"');
  });

  it("点击锚点滚到容器内目标；找不到时提示", () => {
    // jsdom 未实现 scrollIntoView；浏览器始终有，测试里补桩即可
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});

    const root = document.createElement("div");
    root.innerHTML = parse("## 目标\n\n## 空节\n");
    document.body.appendChild(root);

    const ok = root.querySelector<HTMLAnchorElement>('a[href="#目标"]');
    expect(ok).toBeTruthy();
    expect(handleAnchorClick(root, ok!)).toBe("ok");

    const dead = document.createElement("a");
    dead.setAttribute("href", "#不存在");
    root.appendChild(dead);
    expect(handleAnchorClick(root, dead)).toBe("miss");
    expect(root.querySelector(".md-anchor-miss")?.textContent).toContain("不存在");

    document.body.removeChild(root);
  });
});
