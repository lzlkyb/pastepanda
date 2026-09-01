/**
 * 卡片 → 笔记初稿的抽取规则（知识库 A 阶段 · 规划 §8.1 3️⃣）。
 *
 * 重点钉住两件事：
 * ① 哪些卡片类型**不支持**转笔记（返回 null → 菜单项不出现）——
 *   这是“先显示再报错”还是“根本不显示”的分界线（设计稿 §7）；
 * ② diagram / rich 取的是 `text` 而不是 `content`——后者是 JSON / HTML。
 */
import { describe, it, expect } from "vitest";
import { extractNoteDraft, titleFromContent } from "@/lib/notes/extract";
import type { HistoryItem } from "@/stores/appStore";

function mk(over: Partial<HistoryItem>): HistoryItem {
  return {
    id: "i1",
    text: "",
    time: "2026-08-31 10:00:00",
    type: "text",
    content: "",
    pinned: false,
    source: "",
    workspace: "default",
    ...over,
  };
}

describe("titleFromContent", () => {
  it("取第一行非空内容", () => {
    expect(titleFromContent("\n\n  真正的标题\n第二行")).toBe("真正的标题");
  });

  it("去掉 Markdown 行首标记", () => {
    expect(titleFromContent("## 二级标题")).toBe("二级标题");
    expect(titleFromContent("- 列表项")).toBe("列表项");
    expect(titleFromContent("1. 第一条")).toBe("第一条");
    expect(titleFromContent("> 引用")).toBe("引用");
  });

  it("超长截断并加省略号", () => {
    const t = titleFromContent("a".repeat(200));
    expect(t).toHaveLength(61); // 60 + 一个…
    expect(t.endsWith("\u2026")).toBe(true);
  });

  it("全空白时给个兜底标题，不返回空串", () => {
    expect(titleFromContent("   \n  \n")).toBe("无标题笔记");
  });
});

describe("extractNoteDraft · 不支持的类型", () => {
  it("file 卡片返回 null（正文只是路径，转笔记无意义）", () => {
    expect(extractNoteDraft(mk({ type: "file", text: "a.txt", content: '["D:/a.txt"]' }))).toBeNull();
  });

  it("无 OCR 文字的图片返回 null（否则转出一条空笔记）", () => {
    expect(extractNoteDraft(mk({ type: "image", text: "[图片] 800x600", content: "D:/a.png" }))).toBeNull();
  });

  it("空文本卡片返回 null", () => {
    expect(extractNoteDraft(mk({ type: "text", text: "   \n " }))).toBeNull();
  });
});

describe("extractNoteDraft · 按类型取正文", () => {
  it("纯文本：原文不动，标题取首行", () => {
    const d = extractNoteDraft(mk({ text: "第一行\n第二行" }));
    expect(d).toEqual({ title: "第一行", content: "第一行\n第二行" });
  });

  it("csv：转成 Markdown 表格（预览是 Markdown 渲染的，逗号文本会糊成一团）", () => {
    const d = extractNoteDraft(mk({ text: "a,b\n1,2", content_type: "csv" }));
    expect(d!.content).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("csv 但解不出表（列数不齐）：原文不动，不报错", () => {
    const d = extractNoteDraft(mk({ text: "a,b,c\n1,2", content_type: "csv" }));
    expect(d!.content).toBe("a,b,c\n1,2");
  });

  it("diagram：取 text 而不是 content 里的 JSON", () => {
    const d = extractNoteDraft(
      mk({ type: "diagram", text: "部署流程", content: '{"nodes":[],"edges":[]}' }),
    );
    expect(d!.content).toBe("部署流程");
    expect(d!.content).not.toContain("nodes");
  });

  it("rich：取纯文本形态，不把 HTML 带进正文", () => {
    const d = extractNoteDraft(
      mk({ type: "rich", text: "一段带格式的文字", content: '<p style="color:red">一段</p>' }),
    );
    expect(d!.content).toBe("一段带格式的文字");
    expect(d!.content).not.toContain("<p");
  });

  it("图片有 OCR：注入识别文字并标明来源", () => {
    const d = extractNoteDraft(
      mk({ type: "image", text: "[图片] 800x600", content: "D:/a.png", ocr_text: "发票号 12345" }),
    );
    expect(d!.title).toBe("发票号 12345");
    expect(d!.content).toContain("OCR");
    expect(d!.content).toContain("发票号 12345");
  });
});

// noteToMarkdown 的用例已随函数一起移走（B1 #5）：
// 生成现在在后端 note_md.rs，用例在 data_store/tests.rs 里。
