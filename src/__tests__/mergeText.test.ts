/**
 * v6.4 C 连续合并粘贴：合并纯函数测试。
 */

import { describe, it, expect } from "vitest";
import { mergeTexts } from "@/lib/mergeText";

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
});
