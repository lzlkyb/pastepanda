/**
 * 导出文件「目录（大纲）」的守卫 —— 纯字符串，node 环境。
 *
 * 这一层的失败全都**在本地看不出来**：目录照样渲染成一个漂亮的框，只是点不动
 * （href 与正文 id 对不上）、或者干脆没生成（标题少于两条的阈值写错）。
 * 所以钉三件事：抽得出、跳得到、不乱序。
 *
 * 防假绿核对见文件末尾。
 */
import { describe, it, expect } from "vitest";
import { buildTocHtml, collectHeadings } from "@/lib/markdown/exportToc";
import { buildHtmlDocument } from "@/lib/markdown/exportDoc";
import { EXPORT_RUNTIME } from "@/lib/markdown/exportRuntime";

/** 与 headingHtml（headingAnchor.ts）的真实产物同构：id + data-md-heading + 尾部 # 锚点 */
function h(depth: number, id: string, text: string): string {
  return (
    `<h${depth} id="${id}" data-md-heading="1">${text}` +
    `<a class="md-hanchor" href="#${id}" title="复制此标题链接" aria-label="标题锚点">#</a></h${depth}>\n`
  );
}

const BODY =
  h(1, "合同正文", "合同正文") +
  `<p>正文</p>` +
  h(2, "一-总则", "一、总则") +
  h(3, "1-1-范围", "1.1 <em>范围</em>") +
  h(2, "二-付款", "二、付款 &amp; 交付");

const THEME = { name: "ocean", vars: { "--text-primary": "#111" } };

function build(over: Partial<Parameters<typeof buildHtmlDocument>[0]> = {}) {
  return buildHtmlDocument({
    title: "合同",
    bodyHtml: BODY,
    css: "",
    rootClass: "_md_x_1",
    theme: THEME,
    docId: "ppdoc",
    fields: [],
    ...over,
  });
}

describe("collectHeadings —— 抽得出、顺序对、文字干净", () => {
  it("按文档顺序给出 depth / id / 纯文本，并剥掉预览的 # 锚点", () => {
    const items = collectHeadings(BODY);
    expect(items.map((i) => i.depth)).toEqual([1, 2, 3, 2]);
    expect(items.map((i) => i.id)).toEqual(["合同正文", "一-总则", "1-1-范围", "二-付款"]);
    // 锚点里的 "#" 不能混进标题文字（否则目录每行尾巴都挂一个 #）
    expect(items.map((i) => i.text)).toEqual([
      "合同正文",
      "一、总则",
      "1.1 范围",
      "二、付款 & 交付",
    ]);
    expect(items.some((i) => i.text.includes("#"))).toBe(false);
  });

  it("实体只解一次（目录里不能出现 &amp;amp; 这种二次转义）", () => {
    const html = buildTocHtml(collectHeadings(BODY));
    expect(html).toContain("二、付款 &amp; 交付");
    expect(html).not.toContain("&amp;amp;");
  });

  it("没有 id 的标题跳过（列出来就是 href=\"#\" 的死链）", () => {
    expect(collectHeadings("<h2>裸标题</h2><h2 id=\"a\">有 id</h2>")).toEqual([
      { depth: 2, id: "a", text: "有 id" },
    ]);
  });

  it("空标题退回 id 当文字（不能渲染出一行空白）", () => {
    expect(collectHeadings(h(2, "abc", ""))[0].text).toBe("abc");
  });

  it("层次不匹配的标签不会被误配（<h2>…</h3>）", () => {
    expect(collectHeadings("<h2 id=\"x\">标题</h3>")).toEqual([]);
  });
});

describe("buildTocHtml —— 折叠块 + 锚点", () => {
  it("少于两条标题不生成目录（比正文还长的「目录」是噪声）", () => {
    expect(buildTocHtml([])).toBe("");
    expect(buildTocHtml(collectHeadings(h(1, "only", "唯一")))).toBe("");
  });

  it("最小深度归一为 1 级（文档从 h2 起写时不整体右移）", () => {
    const html = buildTocHtml([
      { depth: 2, id: "a", text: "A" },
      { depth: 3, id: "b", text: "B" },
    ]);
    expect(html).toContain('class="pp-toc-i pp-toc-l1"');
    expect(html).toContain('class="pp-toc-i pp-toc-l2"');
  });

  it("是 <details open> + 真实锚点，不嵌任何脚本", () => {
    const html = buildTocHtml(collectHeadings(BODY));
    expect(html).toContain("<details open>");
    expect(html).toContain("<summary>目录 · 4 节</summary>");
    expect(html).toContain('href="#一-总则"');
    expect(html).not.toContain("<script");
  });

  it("标题文字做转义（< > & 会破坏列表结构）", () => {
    const html = buildTocHtml([
      { depth: 1, id: "a", text: "A" },
      { depth: 1, id: "b", text: "<b>&" },
    ]);
    expect(html).toContain("&lt;b&gt;&amp;");
    expect(html).not.toContain("<b>&");
  });
});

describe("buildHtmlDocument —— 目录真的进了产物", () => {
  it("目录排在工具条之后、正文之前", () => {
    const html = build();
    const tocAt = html.indexOf('<nav class="pp-toc"');
    const bodyAt = html.indexOf("data-pp-root");
    expect(tocAt).toBeGreaterThan(0);
    expect(tocAt).toBeLessThan(bodyAt);
  });

  it("目录里的每个 href 都能在正文里找到同 id 的标题（点得动）", () => {
    const html = build();
    const hrefs = [...html.matchAll(/<a href="#([^"]+)" title="/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(4);
    for (const id of hrefs) {
      expect(html, `目录指向的 #${id} 在正文里不存在`).toContain(`id="${id}"`);
    }
  });

  it("没有标题时不留空的目录框", () => {
    expect(build({ bodyHtml: "<p>只有正文</p>" })).not.toContain('class="pp-toc"');
  });

  it("纯阅读导出仍然零脚本（目录是结构，不是交互）", () => {
    const html = build({ runtimeJs: EXPORT_RUNTIME });
    expect(html).toContain('class="pp-toc"');
    expect(html).not.toContain("<script");
  });

  it("只有任务框（没有表单字段）也要嵌运行时，否则勾选记不住", () => {
    const html = build({ taskCount: 2, runtimeJs: EXPORT_RUNTIME });
    expect(html).toContain("<script");
    expect(html).toContain("下载已填版本");
    // 没有字段时「复制填写结果」无从复制，按钮不该出现（运行时源码里那句 toast 不算）
    expect(html).not.toContain('data-pp="copy"');
    expect(html).toContain("填写与勾选只保存在本机浏览器");
  });

  it("既无字段也无任务 → 零脚本、无工具条", () => {
    const html = build({ runtimeJs: EXPORT_RUNTIME });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("下载已填版本");
  });
});

/**
 * 防假绿核对（都实跑过，改回错误实现会精确变红）：
 * - 注释掉 exportDoc 里的 `${toc}`：`目录真的进了产物` 三条全红；
 * - 把 `item.depth - min + 1` 写成 `item.depth`：`最小深度归一` 变红；
 * - 把 `<details open>` 改成 `<details>`：仍是合法 HTML，但 `是 <details open>` 变红；
 * - 去掉 `if (!id) continue`：`没有 id 的标题跳过` 变红（会出现 id="" 的项）；
 * - 把 taskCount 从 hasForm 条件里摘掉：`只有任务框…也要嵌运行时` 变红。
 */
