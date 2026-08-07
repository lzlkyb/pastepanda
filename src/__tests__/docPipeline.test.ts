/**
 * docPipeline.test.ts — 文档处理管线纯函数测试。
 *
 * 覆盖：sanitizeDocHtml（白名单清洗）、htmlToMarkdown（turndown 转换）、
 * tables（GFM 转换与合并单元格检测）、pdfRepair（断行修复）。
 * jsdom 提供 DOMParser，与 WebView 环境一致。
 */

import { describe, it, expect } from "vitest";
import { sanitizeDocHtml } from "@/lib/docPipeline/sanitizeDoc";
import { htmlToMarkdown } from "@/lib/docPipeline/htmlToMarkdown";
import { hasMergedCells, htmlTableToGfm } from "@/lib/docPipeline/tables";
import { repairPdfText, looksLikePdfText } from "@/lib/docPipeline/pdfRepair";

describe("sanitizeDocHtml", () => {
  it("删除 script/style 标签及内容", () => {
    const html = '<p>正文</p><script>alert(1)</script><style>.x{}</style>';
    const result = sanitizeDocHtml(html);
    expect(result).not.toContain("script");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("<style");
    expect(result).toContain("正文");
  });

  it("保留表格/链接/标题结构", () => {
    const html = '<h1>标题</h1><table><tr><td>单元格</td></tr></table><a href="https://example.com">链接</a>';
    const result = sanitizeDocHtml(html);
    expect(result).toContain("<h1>标题</h1>");
    expect(result).toContain("<table>");
    expect(result).toContain("<a href=\"https://example.com\">");
    expect(result).toContain("单元格");
  });

  it("删除 mso 样式与 class 属性", () => {
    const html = '<p style="mso-line-height:1.5;color:red" class="MsoNormal">文本</p>';
    const result = sanitizeDocHtml(html);
    expect(result).not.toContain("mso");
    expect(result).not.toContain("style=");
    expect(result).not.toContain("class=");
    expect(result).toContain("文本");
  });

  it("unwrap 不在白名单的标签", () => {
    const html = "<div><font color=\"red\">文本</font></div>";
    const result = sanitizeDocHtml(html);
    expect(result).not.toContain("<font");
    expect(result).toContain("文本");
  });
});

describe("htmlToMarkdown", () => {
  it("标题与段落转换", () => {
    const md = htmlToMarkdown("<h1>标题</h1><p>段落文本</p>");
    expect(md).toContain("# 标题");
    expect(md).toContain("段落文本");
  });

  it("无序列表转换", () => {
    const md = htmlToMarkdown("<ul><li>项一</li><li>项二</li></ul>");
    expect(md).toMatch(/[-*]\s*项一/);
    expect(md).toMatch(/[-*]\s*项二/);
  });

  it("链接转换", () => {
    const md = htmlToMarkdown('<a href="https://example.com">链接文本</a>');
    expect(md).toContain("[链接文本](https://example.com)");
  });

  it("简单表格转 GFM", () => {
    const md = htmlToMarkdown("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    const norm = md.replace(/\s+/g, " ");
    expect(norm).toContain("| A | B |");
    expect(norm).toContain("| --- | --- |");
    expect(norm).toContain("| 1 | 2 |");
  });

  it("剥离 script 后再转换", () => {
    const md = htmlToMarkdown("<script>alert(1)</script><p>文本</p>");
    expect(md).not.toContain("alert");
    expect(md).toContain("文本");
  });
});

describe("tables", () => {
  it("检测合并单元格", () => {
    expect(hasMergedCells("<td colspan=\"2\">合并</td>")).toBe(true);
    expect(hasMergedCells("<td rowspan=\"3\">合并</td>")).toBe(true);
    expect(hasMergedCells("<td>普通</td>")).toBe(false);
  });

  it("规则表格转 GFM", () => {
    const html = "<table><tr><th>姓名</th><th>年龄</th></tr><tr><td>张三</td><td>28</td></tr></table>";
    const gfm = htmlTableToGfm(html);
    expect(gfm).toContain("| 姓名 | 年龄 |");
    expect(gfm).toContain("| --- | --- |");
    expect(gfm).toContain("| 张三 | 28 |");
  });

  it("合并单元格返回 null", () => {
    const html = "<table><tr><td colspan=\"2\">合并</td></tr></table>";
    expect(htmlTableToGfm(html)).toBeNull();
  });

  it("无表格返回 null", () => {
    expect(htmlTableToGfm("<p>无表格</p>")).toBeNull();
  });
});

describe("pdfRepair", () => {
  it("合并段内硬换行（英文加空格）", () => {
    const text = "This is line one\nand line two\ncontinues here.";
    const result = repairPdfText(text);
    expect(result).toBe("This is line one and line two continues here.");
  });

  it("合并段内硬换行（中文不加空格）", () => {
    const text = "这是第一行\n第二行继续\n第三行。";
    const result = repairPdfText(text);
    expect(result).toBe("这是第一行第二行继续第三行。");
  });

  it("保留段落分隔（双换行）", () => {
    const text = "第一段第一行\n第二行\n\n第二段第一行\n第二行";
    const result = repairPdfText(text);
    expect(result).toContain("\n\n");
    const paras = result.split("\n\n");
    expect(paras[0]).toBe("第一段第一行第二行");
    expect(paras[1]).toBe("第二段第一行第二行");
  });

  it("连字符断词还原", () => {
    const text = "This is a hyphen-\nated word.";
    const result = repairPdfText(text);
    expect(result).toBe("This is a hyphenated word.");
  });

  it("列表项行不合并", () => {
    const text = "1. 第一项\n2. 第二项\n3. 第三项";
    const result = repairPdfText(text);
    expect(result).toContain("1. 第一项\n2. 第二项\n3. 第三项");
  });

  it("连字字符修复", () => {
    const result = repairPdfText("re\uFB01ned op\uFB02c");
    expect(result).toContain("refined");
    expect(result).toContain("opflc");
  });

  it("looksLikePdfText 识别多短行", () => {
    const pdfLike = "Line one here\nLine two here\nLine three here\nLine four here\nLine five here\nLine six here";
    expect(looksLikePdfText(pdfLike)).toBe(true);
  });

  it("looksLikePdfText 拒绝正常段落", () => {
    const normal = "This is a normal paragraph that is long enough to not trigger the PDF detection heuristic.";
    expect(looksLikePdfText(normal)).toBe(false);
  });
});
