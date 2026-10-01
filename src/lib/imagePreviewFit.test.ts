import { describe, expect, it } from "vitest";
import { clampImageZoom, imageFitScale } from "./imagePreviewFit";

describe("图片详情适应窗口", () => {
  it("550px 主窗口里的横图和竖图均完整落在画布内", () => {
    expect(imageFitScale(1920, 1080, 518, 550, 0)).toBeCloseTo(494 / 1920);
    expect(imageFitScale(1080, 1920, 518, 550, 0)).toBeCloseTo(526 / 1920);
  });

  it("旋转后交换宽高，最小窗口仍能显示完整图片", () => {
    const fit = imageFitScale(1920, 1080, 288, 240, 90);
    expect(1080 * fit).toBeLessThanOrEqual(264);
    expect(1920 * fit).toBeLessThanOrEqual(216);
  });

  it("不放大小图，超大图的缩小操作也不会反向放大", () => {
    expect(imageFitScale(120, 80, 500, 500, 0)).toBe(1);
    const fit = imageFitScale(10000, 8000, 288, 240, 0);
    expect(fit).toBeLessThan(0.2);
    expect(clampImageZoom(fit / 1.25, fit)).toBeLessThan(fit);
  });
});
