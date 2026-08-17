import { describe, expect, it } from "vitest";
import { blurSampleRect } from "@/lib/screenshot/blurRect";

/** 底图尺寸（假想的 1920x1080 全屏） */
const BW = 1920;
const BH = 1080;

describe("blurSampleRect · 模糊采样 padding", () => {
  it("区域在底图中间：四侧都拿到完整 padding", () => {
    const r = blurSampleRect(500, 400, 200, 100, 6, BW, BH);
    const pad = 12; // 6 * 2
    expect(r).toEqual({
      sx: 500 - pad,
      sy: 400 - pad,
      sw: 200 + pad * 2,
      sh: 100 + pad * 2,
      padL: pad,
      padT: pad,
    });
  });

  it("贴左上角：那两侧 padding 为 0，采样不会走到负坐标", () => {
    const r = blurSampleRect(0, 0, 200, 100, 8, BW, BH);
    expect(r.sx).toBe(0);
    expect(r.sy).toBe(0);
    expect(r.padL).toBe(0);
    expect(r.padT).toBe(0);
    // 右下仍然拿到完整 16px，所以宽高只多了一侧
    expect(r.sw).toBe(200 + 16);
    expect(r.sh).toBe(100 + 16);
  });

  it("贴右下角：采样矩形不超出底图", () => {
    const r = blurSampleRect(BW - 200, BH - 100, 200, 100, 8, BW, BH);
    expect(r.sx + r.sw).toBeLessThanOrEqual(BW);
    expect(r.sy + r.sh).toBeLessThanOrEqual(BH);
    // 左上仍然拿得到 16px
    expect(r.padL).toBe(16);
    expect(r.padT).toBe(16);
  });

  it("四侧分开算：贴左边时不能把右侧那圈真像素一起丢掉", () => {
    // 这条守的是一个具体实现陷阱：若取 pad = min(四侧可用) 统一向外扩，
    // 选区贴左边时 pad 就成 0，右侧本来能拿到的像素也没了，右边照样羽化。
    const r = blurSampleRect(0, 400, 200, 100, 10, BW, BH);
    expect(r.padL).toBe(0);
    expect(r.sw).toBe(200 + 20); // 右侧拿到了完整 20px
  });

  it("区域比底图还大（异常输入）：padding 归零且不产生负值", () => {
    const r = blurSampleRect(-50, -50, BW + 200, BH + 200, 8, BW, BH);
    expect(r.padL).toBe(0);
    expect(r.padT).toBe(0);
    expect(r.sx).toBe(-50); // 不去修正调用方传错的区域，只保证不额外向外扩
    expect(r.sw).toBe(BW + 200);
  });

  it("半径 0：不加 padding（退化回原行为）", () => {
    const r = blurSampleRect(500, 400, 200, 100, 0, BW, BH);
    expect(r).toEqual({ sx: 500, sy: 400, sw: 200, sh: 100, padL: 0, padT: 0 });
  });

  it("半径为负（异常输入）：当成 0 而不是算出负 padding", () => {
    const r = blurSampleRect(500, 400, 200, 100, -5, BW, BH);
    expect(r.padL).toBe(0);
    expect(r.sw).toBe(200);
  });
});
