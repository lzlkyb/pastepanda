import { describe, it, expect } from "vitest";
import {
  layout,
  equilibrium,
  defaultAnchors,
  constrainAnchors,
  moveAnchors,
  ropePoint,
  springProgress,
  canSettle,
  insertAtSlot,
  WIND_TIMING,
} from "../clothesline/physics.mjs";
const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), aspect: 1.6 }));
describe("生产晾衣绳运动与边界", () => {
  it("窄工作区仍保留最小跨度，默认右端点降到灵动岛下方", () => {
    const a = defaultAnchors(432);
    expect(a.right.x - a.left.x).toBeGreaterThanOrEqual(240);
    expect(a.right.y).toBeGreaterThanOrEqual(80);
  });
  it("载荷递增，端点固定，下垂不超过60px且最多8张可见", () => {
    let last = 0;
    for (let n = 0; n <= 12; n++) {
      const g = layout(1440, items.slice(0, n)),
        curve = equilibrium(g),
        peak = Math.max(...curve);
      expect(peak).toBeGreaterThanOrEqual(last);
      expect(peak).toBeLessThanOrEqual(60);
      expect(curve[0]).toBe(0);
      expect(curve[curve.length - 1]).toBe(0);
      expect(g.cards.length).toBeLessThanOrEqual(8);
      last = peak;
    }
  });
  it("允许端点不同高度，拖动边界避免交叉且不锁死顶部横向移动", () => {
    const a = defaultAnchors(1440);
    a.left.y = 120;
    const b = constrainAnchors({ ...a, right: { x: 1439, y: 10 } }, "right", 1440, 760);
    expect(b.right.x).toBe(1416);
    expect(b.right.y).toBe(32);
    const g = layout(1440, items.slice(0, 2), b),
      curve = equilibrium(g);
    expect(ropePoint(g, curve, 0).y).toBe(120);
    expect(ropePoint(g, curve, 1).y).toBe(32);
    const c = constrainAnchors({ ...b, left: { x: 1300, y: 900 } }, "left", 1440, 760);
    expect(c.right.x - c.left.x).toBeGreaterThanOrEqual(240);
    expect(c.left.y).toBe(480);
  });
  it("整体移动保持跨度，窗口缩小时位置仍能回到边界内", () => {
    const a = defaultAnchors(1024),
      b = moveAnchors(a, -500, -500, 1024, 760);
    expect(b.right.x - b.left.x).toBe(a.right.x - a.left.x);
    expect(b.left.x).toBe(24);
    expect(b.left.y).toBe(32);
  });
  it("默认高度整绳向右拖动时跟手，不能被右侧预留区域卡住", () => {
    const a = defaultAnchors(1440),
      b = moveAnchors(a, 120, 0, 1440, 760);
    expect(b.left.x).toBe(a.left.x + 120);
    expect(b.right.x).toBe(a.right.x + 120);
    expect(b.left.y).toBe(a.left.y);
    expect(moveAnchors(b, -100, 0, 1440, 760).left.x).toBe(b.left.x - 100);
  });
  it("满绳挂回可见，旧图排队且没有重复ID", () => {
    const result = insertAtSlot(items, { id: "return", aspect: 2 }, 0, 8),
      g = layout(1440, result);
    expect(g.cards.some((c) => c.item.id === "return")).toBe(true);
    expect(result.length).toBe(13);
    expect(new Set(insertAtSlot(result, result[0], 3, 8).map((i) => i.id)).size).toBe(13);
  });
  it("弹性有回弹并收敛；隐藏、减少动态、拖拽和预览停止逐帧响应", () => {
    expect(springProgress(0.4)).toBeGreaterThan(1);
    expect(springProgress(1.2)).toBeCloseTo(1, 3);
    const base = { enabled: true, hidden: false, reduced: false, dragging: false, preview: false };
    expect(canSettle(base)).toBe(true);
    for (const key of ["hidden", "reduced", "dragging", "preview"])
      expect(canSettle({ ...base, [key]: true })).toBe(false);
    expect(WIND_TIMING.lead + 7 * WIND_TIMING.stagger + WIND_TIMING.flight).toBe(1720);
  });
});
