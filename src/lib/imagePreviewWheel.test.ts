import { describe, expect, it } from "vitest";
import { shouldZoomImageWheel } from "./imagePreviewWheel";

describe("图片详情滚轮归属", () => {
  it("浮层及内部文字、输入框和图标滚动时不缩放图片", () => {
    const overlay = document.createElement("div");
    overlay.dataset.imagePreviewOverlay = "";
    const text = document.createElement("div");
    const editor = document.createElement("textarea");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    text.append(editor, icon);
    overlay.append(text);

    for (const target of [overlay, text, editor, icon]) {
      expect(shouldZoomImageWheel(target)).toBe(false);
    }
  });

  it("图片与空白画布仍可通过滚轮缩放", () => {
    expect(shouldZoomImageWheel(document.createElement("img"))).toBe(true);
    expect(shouldZoomImageWheel(document.createElement("div"))).toBe(true);
  });
});
