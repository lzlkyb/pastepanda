/**
 * extractNoteDraft 的守卫单测。
 *
 * 🔴 核心不变量（规则 #11 收口）：rich / doc 卡片转笔记**必须**先走
 * HTML→Markdown 转换器（draftFromHtml），纯文本只是转换失败时的兜底。
 * 这条不变量被绕开的后果：网页文章转进知识库丢掉全部结构，用户看到的
 * 是一坨没有标题层级的散文本。
 */
import { describe, expect, it } from "vitest";
import { extractNoteDraft } from "./extract";
import type { HistoryItem } from "@/stores/appStore";

const baseItem = {
  id: "h1",
  time: "",
  item_type: "text",
  content: "",
  pinned: false,
  source: "",
  workspace: "",
  md5: "",
  pinyin_initials: "",
  group_id: null,
  tags: [],
  source_icon: "",
  content_type: null,
  ocr_text: null,
  barcodes: [],
};

const item = (over: Partial<HistoryItem>): HistoryItem =>
  ({ ...baseItem, ...over }) as HistoryItem;

describe("extractNoteDraft：rich/doc 走 HTML 转换器（守卫）", () => {
  it("rich 卡片：content 里的 HTML 转成带结构的 Markdown", () => {
    const draft = extractNoteDraft(
      item({
        type: "rich",
        text: "这就是文章标题 正文文字",
        content: "<h1>这就是文章标题</h1><p>正文<strong>重点</strong></p>",
      }),
    );
    expect(draft).not.toBeNull();
    expect(draft!.title).toBe("这就是文章标题");
    expect(draft!.content).toContain("# 这就是文章标题");
    expect(draft!.content).toContain("正文**重点**");
  });

  it("doc 卡片：同样走 HTML 转换器", () => {
    const draft = extractNoteDraft(
      item({ type: "doc", content: "<h2>章节</h2><ul><li>要点</li></ul>", text: "章节 要点" }),
    );
    expect(draft!.content).toContain("## 章节");
    expect(draft!.content).toContain("- 要点");
  });

  it("rich 卡片没有 HTML（content 为空）→ 兜底纯文本，不返回 null", () => {
    const draft = extractNoteDraft(item({ type: "rich", text: "只有纯文本的内容", content: "" }));
    expect(draft).not.toBeNull();
    expect(draft!.content).toBe("只有纯文本的内容");
  });

  it("HTML 转出的内容明显短于纯文本 → 回退纯文本（CF_HTML 片段残缺保底）", () => {
    const draft = extractNoteDraft(
      item({
        type: "rich",
        text: "一段带格式的文字",
        content: '<p style="color:red">一段</p>',
      }),
    );
    expect(draft).not.toBeNull();
    expect(draft!.content).toBe("一段带格式的文字");
    expect(draft!.content).not.toContain("<p");
  });

  it("doc 卡片 csv 子类型：保持走表格转换，不吃 HTML 路径", () => {
    const draft = extractNoteDraft(
      item({
        type: "doc",
        text: "name,age\n张三,20",
        content: "<table><tr><td>name</td><td>age</td></tr></table>",
        content_type: "csv",
      }),
    );
    // csv 路径的标志：竖线表格来自 csvToMarkdown，而不是 HTML 转换器的 GFM 表
    expect(draft!.content).toContain("| name | age |");
  });

  it("text 卡片行为不变（不受本次升级影响）", () => {
    const draft = extractNoteDraft(item({ type: "text", text: "普通文本", content: "" }));
    expect(draft!.content).toBe("普通文本");
  });

  it("file 卡片仍不支持转笔记", () => {
    expect(extractNoteDraft(item({ type: "file", text: "C:/a.txt" }))).toBeNull();
  });
});
