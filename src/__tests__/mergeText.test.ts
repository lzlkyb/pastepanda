/**
 * v6.4 C 连续合并粘贴：合并纯函数测试。
 */

import { describe, it, expect } from "vitest";
import { mergeTexts, stackItemsToMergeItems } from "@/lib/mergeText";
import type { HistoryItem } from "@/stores/appStore";

describe("mergeTexts 各分隔方式", () => {
  const texts = ["第一段", "第二段", "第三段"];

  it("换行", () => {
    expect(mergeTexts(texts, "newline")).toBe("第一段\n第二段\n第三段");
  });

  it("逗号", () => {
    expect(mergeTexts(texts, "comma")).toBe("第一段, 第二段, 第三段");
  });

  it("分号", () => {
    expect(mergeTexts(texts, "semicolon")).toBe("第一段；第二段；第三段");
  });

  it("编号列表", () => {
    expect(mergeTexts(texts, "numbered")).toBe("1. 第一段\n2. 第二段\n3. 第三段");
  });

  it("自定义分隔符", () => {
    expect(mergeTexts(texts, "custom", " | ")).toBe("第一段 | 第二段 | 第三段");
    expect(mergeTexts(texts, "custom")).toBe("第一段、第二段、第三段"); // 默认顿号
  });

  it("自动过滤空段", () => {
    expect(mergeTexts(["  ", "甲", " 乙 "], "comma")).toBe("甲, 乙");
  });

  it("空输入 → 空串", () => {
    expect(mergeTexts([], "newline")).toBe("");
    expect(mergeTexts(["  "], "newline")).toBe("");
  });

  // P2 新增两种分隔符（拖拽栈合并粘贴）
  describe("markdown 列表", () => {
    it("每段前加 - ", () => {
      expect(mergeTexts(["第一段", "第二段"], "markdown")).toBe("- 第一段\n- 第二段");
    });

    it("多行内容仅在首行加 - ，其余行保持原样（不把每一行都变成列表项）", () => {
      expect(mergeTexts(["标题\n正文第二行", "另一段"], "markdown")).toBe(
        "- 标题\n正文第二行\n- 另一段",
      );
    });
  });

  describe("smart 智能换行", () => {
    const SHORT_A = "短句A";
    const SHORT_B = "短句B";
    const LONG = "这是一段非常长的文字".repeat(5); // > 40 字符

    it("连续短段落用单换行连接", () => {
      expect(mergeTexts([SHORT_A, SHORT_B], "smart")).toBe(`${SHORT_A}\n${SHORT_B}`);
    });

    it("长段落前后用空行隔开", () => {
      expect(mergeTexts([SHORT_A, LONG, SHORT_B], "smart")).toBe(
        `${SHORT_A}\n\n${LONG}\n\n${SHORT_B}`,
      );
    });

    it("含内部换行的段落视为长段落（即使字数未超 40）", () => {
      const multiline = "第一行\n第二行";
      expect(mergeTexts([SHORT_A, multiline], "smart")).toBe(`${SHORT_A}\n\n${multiline}`);
    });
  });
});

function makeHistoryItem(overrides: Partial<HistoryItem> & { id: string; text: string }): HistoryItem {
  return {
    type: "text" as const,
    time: "2026-01-01 12:00:00",
    content: "",
    pinned: false,
    source: "clipboard",
    workspace: "默认",
    ...overrides,
  };
}

describe("stackItemsToMergeItems（P2 栈条目 → MergeItem 适配）", () => {
  it("有 text 时直接用现有 text（图片/文件条目的 text 本身已经是标签）", () => {
    const items = [
      makeHistoryItem({ id: "a", text: "姓名：张三", type: "text" }),
      makeHistoryItem({ id: "b", text: "身份证截图", type: "image", content: "C:\\id.png" }),
    ];
    expect(stackItemsToMergeItems(items)).toEqual([
      { id: "a", text: "姓名：张三" },
      { id: "b", text: "身份证截图" },
    ]);
  });

  it("text 为空时回退到带方括号的类型占位", () => {
    const items = [
      makeHistoryItem({ id: "a", text: "", type: "image", content: "C:\\x.png" }),
      makeHistoryItem({ id: "b", text: "", type: "file", content: "C:\\x.txt" }),
    ];
    expect(stackItemsToMergeItems(items)).toEqual([
      { id: "a", text: "[图片]" },
      { id: "b", text: "[文件]" },
    ]);
  });
});
