/**
 * `insertAtCursor` 的用例。它现在被两处共用（AI 自定义动作的插入占位符、
 * 转笔记模板的变量按钮），改到那里会同时影响两个功能，所以钉住。
 */
import { describe, it, expect, vi } from "vitest";
import { insertAtCursor } from "@/lib/insertAtCursor";

/** 最小伪元素：只给 insertAtCursor 真正读写的那几个成员 */
function fakeEl(start: number, end = start) {
  return {
    selectionStart: start,
    selectionEnd: end,
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
  } as unknown as HTMLTextAreaElement;
}

describe("insertAtCursor", () => {
  it("插到光标处，而不是追加到末尾", () => {
    expect(insertAtCursor(fakeEl(3), "abcdef", "XY")).toBe("abcXYdef");
  });

  it("有选中区时替掉选中内容", () => {
    expect(insertAtCursor(fakeEl(1, 4), "abcdef", "-")).toBe("a-ef");
  });

  it("光标在文首 / 文末都正常", () => {
    expect(insertAtCursor(fakeEl(0), "abc", "X")).toBe("Xabc");
    expect(insertAtCursor(fakeEl(3), "abc", "X")).toBe("abcX");
  });

  it("拿不到元素时退化成追加到末尾，而不是什么都不插", () => {
    expect(insertAtCursor(null, "abc", "{{x}}")).toBe("abc{{x}}");
  });

  it("不改原字符串（纯函数，调用方自己写回 state）", () => {
    const src = "abcdef";
    insertAtCursor(fakeEl(2), src, "ZZ");
    expect(src).toBe("abcdef");
  });
});
