import { describe, expect, it } from "vitest";
import { mapNormFromCanvas } from "@/hooks/useRcInput";

function fakeCanvas(rect: { left: number; top: number; width: number; height: number }) {
  return {
    getBoundingClientRect: () => ({ ...rect, right: 0, bottom: 0, x: 0, y: 0 }),
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

describe("mapNormFromCanvas", () => {
  it("fit(contain)：letterbox 中心对齐", () => {
    // 画布 200×100，内容 1:1 → scale=1，居中 ox=50
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const mid = mapNormFromCanvas({ clientX: 100, clientY: 50 }, el, 100, 100, "fit");
    expect(mid.x).toBeGreaterThanOrEqual(32767);
    expect(mid.x).toBeLessThanOrEqual(32768);
    expect(mid.y).toBeGreaterThanOrEqual(32767);
    expect(mid.y).toBeLessThanOrEqual(32768);
  });

  it("fill(cover)：溢出裁切时点击中心仍映射到中心", () => {
    // 画布 200×100，内容 1:1 → cover scale=1，同样居中
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const mid = mapNormFromCanvas({ clientX: 100, clientY: 50 }, el, 100, 100, "fill");
    expect(mid.x).toBeGreaterThanOrEqual(32767);
    expect(mid.x).toBeLessThanOrEqual(32768);
    expect(mid.y).toBeGreaterThanOrEqual(32767);
    expect(mid.y).toBeLessThanOrEqual(32768);
  });

  it("fill：宽内容被裁切时，画布右缘点击对应内容更靠右", () => {
    // 画布 200×100，内容 100×100 → cover scale=2，显示宽 200，ox=0
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const left = mapNormFromCanvas({ clientX: 0, clientY: 50 }, el, 100, 100, "fill");
    const right = mapNormFromCanvas({ clientX: 199, clientY: 50 }, el, 100, 100, "fill");
    expect(left.x).toBe(0);
    expect(right.x).toBeGreaterThan(60000);
  });

  it("fit：窄内容有左右留边时，留边外点击被 clamp", () => {
    // 画布 200×100，内容 100×100 → contain scale=1，ox=50
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const outside = mapNormFromCanvas({ clientX: 10, clientY: 50 }, el, 100, 100, "fit");
    expect(outside.x).toBe(0);
  });
});
