import { describe, expect, it } from "vitest";
import { layoutOcrCopyBar, OCR_BAR_W, OCR_BAR_H, OCR_BAR_GAP } from "@/lib/screenshot/ocrBarPos";

const VW = 800;
const VH = 600;

describe("layoutOcrCopyBar", () => {
  it("默认右下：矩形不在边缘时贴在右下角", () => {
    const r = layoutOcrCopyBar({ x: 100, y: 100, w: 200, h: 80 }, VW, VH);
    expect(r.place).toBe("br");
    expect(r.left).toBe(100 + 200 + OCR_BAR_GAP);
    expect(r.top).toBe(100 + 80 + OCR_BAR_GAP);
  });

  it("贴屏幕右缘：翻到左下（水平翻转）", () => {
    // 右下放不下（left + barW 溢出），左下放得下
    const r = layoutOcrCopyBar({ x: 700, y: 100, w: 80, h: 80 }, VW, VH);
    expect(r.place).toBe("bl");
    expect(r.left).toBe(700 - OCR_BAR_W - OCR_BAR_GAP);
  });

  it("贴屏幕底缘：翻到右上（垂直翻转）", () => {
    // y=520 时右下 top 溢出（520+80+6+34=640 > 600），右上放得下
    const r = layoutOcrCopyBar({ x: 100, y: 520, w: 200, h: 80 }, VW, VH);
    expect(r.place).toBe("tr");
    expect(r.top).toBe(520 - OCR_BAR_H - OCR_BAR_GAP);
  });

  it("右下角同时贴边：翻到左上（双翻转）", () => {
    // y=560：右下 top 溢出；左下 top 也溢出（560+80+6+34=680>600）→ 左上
    const r = layoutOcrCopyBar({ x: 700, y: 560, w: 80, h: 80 }, VW, VH);
    expect(r.place).toBe("tl");
    expect(r.left).toBe(700 - OCR_BAR_W - OCR_BAR_GAP);
    expect(r.top).toBe(560 - OCR_BAR_H - OCR_BAR_GAP);
  });

  it("四象限都放不下：钳进视口（仍完全可见可点）", () => {
    // 视口 180x120（略大于复制条 168x34），矩形贴左上角、其余候选均溢出 → 兜底钳制
    const r = layoutOcrCopyBar({ x: 0, y: 0, w: 100, h: 100 }, 180, 120);
    expect(r.place).toBe("fit");
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.left + OCR_BAR_W).toBeLessThanOrEqual(180);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.top + OCR_BAR_H).toBeLessThanOrEqual(120);
  });

  it("贴右缘且贴底：左下、右上都溢出 → 左上", () => {
    // x 靠右导致 bl 溢出 left<0？700-168-6=526 ≥0 不溢出；但 y=520 时 bl 的 top 溢出 bottom → 试右上
    const r = layoutOcrCopyBar({ x: 600, y: 520, w: 150, h: 60 }, VW, VH);
    // bl: left=600-168-6=426≥0 但 top=520+60+6=586 > 600-34 → 溢出 → 换 tr: top=520-34-6=480≥0,
    //     left=600+150+6=756 ≤ 800-168=632? 756+168=924>800 溢出 → tl: left=426≥0, top=480≥0 ✅
    expect(r.place).toBe("tl");
  });
});
