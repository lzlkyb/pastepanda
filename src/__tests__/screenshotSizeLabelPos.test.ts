import { describe, expect, it } from "vitest";
import {
  layoutSizeLabel,
  SIZE_LABEL_GAP,
  SIZE_LABEL_H,
} from "@/lib/screenshot/sizeLabelPos";

const VH = 1080;

describe("layoutSizeLabel · 尺寸标签避让", () => {
  it("选区在屏幕中间：挂在下方", () => {
    const r = layoutSizeLabel(300, 200, VH);
    expect(r.place).toBe("below");
    expect(r.top).toBe(200 + SIZE_LABEL_GAP);
  });

  it("选区贴屏幕底部：翻到上方（旧实现在这里被裁掉）", () => {
    // 选区底边正好到屏幕底 → 下方完全没位置
    const r = layoutSizeLabel(VH - 200, 200, VH);
    expect(r.place).toBe("above");
    expect(r.top).toBe(-(SIZE_LABEL_H + SIZE_LABEL_GAP));
  });

  it("翻到上方后标签顶边仍在视口内", () => {
    const selTop = VH - 200;
    const r = layoutSizeLabel(selTop, 200, VH);
    expect(selTop + r.top).toBeGreaterThanOrEqual(0);
  });

  it("差一点就放不下时也要翻（边界）", () => {
    // 刚好放得下：selTop + selH + GAP + H == vh
    const fit = layoutSizeLabel(VH - 200 - SIZE_LABEL_GAP - SIZE_LABEL_H, 200, VH);
    expect(fit.place).toBe("below");
    // 再低 1px 就放不下
    const notFit = layoutSizeLabel(VH - 199 - SIZE_LABEL_GAP - SIZE_LABEL_H, 200, VH);
    expect(notFit.place).toBe("above");
  });

  it("选区占满整屏：退到选区内部顶部", () => {
    const r = layoutSizeLabel(0, VH, VH);
    expect(r.place).toBe("inside");
    expect(r.top).toBe(SIZE_LABEL_GAP);
  });

  it("内部态去顶部而不是底部（不能和工具栏撞）", () => {
    // layoutToolbar 在上下都放不下时会贴选区内部**底**边，
    // 所以标签必须跑顶部。这条钉住这个关系，以后改到哪一边都会被提醒。
    const r = layoutSizeLabel(0, VH, VH);
    expect(r.top).toBeLessThan(VH / 2);
  });

  it("选区贴屏幕顶部：仍然用下方（下方本来就放得下）", () => {
    const r = layoutSizeLabel(0, 200, VH);
    expect(r.place).toBe("below");
  });

  it("短屏幕（小视口）下不会算出负向上溢出", () => {
    const vh = 100;
    const r = layoutSizeLabel(0, 100, vh);
    expect(r.place).toBe("inside");
    expect(r.top).toBeGreaterThanOrEqual(0);
  });
});
