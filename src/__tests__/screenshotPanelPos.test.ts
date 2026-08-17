import { describe, expect, it } from "vitest";
import { layoutSidePanel, PANEL_GAP, PANEL_MIN_H } from "@/lib/screenshot/panelPos";

/**
 * OCR 胶囊 / 抽屉的定位。盯旧实现钉死在屏幕右上角造成的两个问题：
 * ① 不跟选区（选区在左下时视线要跨屏）；② 压在选区上面挡内容。
 */

const W = 252; // 抽屉宽
const VW = 1920;
const VH = 1080;

describe("layoutSidePanel · 水平侧选择", () => {
  it("右侧放得下：贴选区右外侧", () => {
    const sel = { x: 200, y: 100, w: 600, h: 400 };
    const r = layoutSidePanel(sel, W, VW, VH);
    expect(r.side).toBe("right");
    expect(r.left).toBe(sel.x + sel.w + PANEL_GAP);
  });

  it("选区贴屏幕右边：退到左外侧，右边缘不越过选区左边缘", () => {
    const sel = { x: 1300, y: 100, w: 600, h: 400 };
    const r = layoutSidePanel(sel, W, VW, VH);
    expect(r.side).toBe("left");
    expect(r.left + W).toBeLessThanOrEqual(sel.x);
  });

  it("选区横贯屏幕：两侧都放不下，贴内部右侧且不出屏", () => {
    const sel = { x: 0, y: 100, w: VW, h: 400 };
    const r = layoutSidePanel(sel, W, VW, VH);
    expect(r.side).toBe("inside");
    expect(r.left).toBeGreaterThanOrEqual(PANEL_GAP);
    expect(r.left + W).toBeLessThanOrEqual(VW - PANEL_GAP);
  });

  it("选区在左下角：面板跟过去，不再蹦到屏幕右上角", () => {
    const sel = { x: 60, y: 700, w: 400, h: 300 };
    const r = layoutSidePanel(sel, W, VW, VH);
    expect(r.left).toBe(sel.x + sel.w + PANEL_GAP);
    expect(r.top).toBeGreaterThan(VH / 2); // 在下半屏，跟着选区
  });
});

describe("layoutSidePanel · 垂直与高度", () => {
  it("顶部对齐选区顶部", () => {
    const sel = { x: 200, y: 260, w: 600, h: 400 };
    expect(layoutSidePanel(sel, W, VW, VH).top).toBe(260);
  });

  it("选区贴屏幕底：上钳，保证至少放得下最小高度", () => {
    const sel = { x: 200, y: VH - 40, w: 600, h: 40 };
    const r = layoutSidePanel(sel, W, VW, VH);
    expect(r.top + PANEL_MIN_H).toBeLessThanOrEqual(VH - PANEL_GAP);
  });

  it("高度不超出屏幕底部", () => {
    const sel = { x: 200, y: 900, w: 600, h: 100 };
    const r = layoutSidePanel(sel, W, VW, VH);
    expect(r.top + r.maxHeight).toBeLessThanOrEqual(VH);
  });
});

describe("layoutSidePanel · 避让工具栏", () => {
  // 窄选区时工具栏退化为左对齐并向右伸出选区，才会与面板相撞
  const narrowSel = { x: 300, y: 200, w: 120, h: 100 };
  const toolbar = { x: 300, y: 308, w: 620, h: 54 };

  it("右侧被工具栏压得放不下时，改到左侧而不是硬挤", () => {
    // 窄矮选区：右侧可用高度只有选区那么高（工具栏就在选区下方 8px），压完不够用；
    // 左侧则完全避开了向右伸出的工具栏，能拿到完整高度。
    const r = layoutSidePanel(narrowSel, W, VW, VH, toolbar);
    expect(r.side).toBe("left");
    expect(r.maxHeight).toBeGreaterThanOrEqual(PANEL_MIN_H);
    // 左侧与工具栏水平不相交，所以不该被压
    expect(r.left + W).toBeLessThanOrEqual(toolbar.x);
  });

  it("水平不相交时不压缩（工具栏右对齐宽选区的常规情形）", () => {
    const wideSel = { x: 200, y: 200, w: 800, h: 300 };
    const tb = { x: 380, y: 508, w: 620, h: 54 }; // 右边缘 = 选区右边缘
    const withAvoid = layoutSidePanel(wideSel, W, VW, VH, tb);
    const without = layoutSidePanel(wideSel, W, VW, VH, null);
    expect(withAvoid.maxHeight).toBe(without.maxHeight);
  });

  it("空间被压到小于最小高度时不再让，宁可盖住工具栏", () => {
    const sel = { x: 300, y: 200, w: 120, h: 100 };
    const tb = { x: 300, y: 240, w: 620, h: 54 }; // 紧贴选区顶部下方
    const r = layoutSidePanel(sel, W, VW, VH, tb);
    expect(r.maxHeight).toBeGreaterThanOrEqual(PANEL_MIN_H);
  });
});
