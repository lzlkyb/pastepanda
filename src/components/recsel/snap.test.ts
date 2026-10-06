/** snap 纯函数守卫：物理→CSS 换算与邻域命中（设计稿二期 §4）。 */
import { describe, expect, it } from "vitest";
import { pickSnapCandidate, toLocalCssRect } from "./snap";

describe("toLocalCssRect：物理虚拟屏 → 覆盖层本地 CSS", () => {
  it("减原点、÷dpr（125% 缩放口径）", () => {
    const r = toLocalCssRect({ x: 240, y: 125, w: 960, h: 540 }, 0, 0, 1.25);
    expect(r).toEqual({ x: 192, y: 100, w: 768, h: 432 });
  });

  it("多屏负原点：先减原点再除", () => {
    const r = toLocalCssRect({ x: -1920, y: -108, w: 1920, h: 864 }, -1920, -108, 1);
    expect(r).toEqual({ x: 0, y: 0, w: 1920, h: 864 });
  });

  it("dpr 异常（0）按 1 处理不产生 NaN", () => {
    const r = toLocalCssRect({ x: 100, y: 50, w: 200, h: 100 }, 0, 0, 0);
    expect(r).toEqual({ x: 100, y: 50, w: 200, h: 100 });
  });
});

describe("pickSnapCandidate：光标邻域命中", () => {
  const wins = [
    { x: 100, y: 100, w: 400, h: 300 },
    { x: 600, y: 100, w: 300, h: 200 },
  ];

  it("窗内命中返回该窗", () => {
    expect(pickSnapCandidate(wins, { x: 300, y: 200 })).toEqual(wins[0]);
  });

  it("8px 邻域内也命中（贴边吸附）", () => {
    expect(pickSnapCandidate(wins, { x: 504, y: 250 })).toEqual(wins[0]); // 右缘外 4px
    expect(pickSnapCandidate(wins, { x: 604, y: 150 })).toEqual(wins[1]); // 窗内
    expect(pickSnapCandidate(wins, { x: 594, y: 250 })).toEqual(wins[1]); // B 左缘外 6px
  });

  it("邻域外返回 null（自由框选）", () => {
    expect(pickSnapCandidate(wins, { x: 560, y: 250 })).toBeNull();
    expect(pickSnapCandidate(wins, { x: 300, y: 200 }, 0)).toEqual(wins[0]); // pad=0 只认窗内
  });

  it("多窗重叠时先到先得（列表序）", () => {
    const overlap = [wins[0], { x: 0, y: 0, w: 800, h: 600 }];
    expect(pickSnapCandidate(overlap, { x: 300, y: 200 })).toEqual(wins[0]);
  });
});
