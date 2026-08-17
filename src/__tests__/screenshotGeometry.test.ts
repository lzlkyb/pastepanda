/**
 * 截图几何：坐标系换算、磁吸对齐、标注命中检测。
 *
 * 两组测试是回归性质的，对应两个真实发生过的 bug：
 * 1. 坐标换算漏了 origin 偏移——单显示器 origin=(0,0) 时恰好看不出来，
 *    副屏摆在主屏左边/上边时 origin 为负，框选会整体偏移；
 * 2. applyMagnet 把参照矩形的 [x, x+w, y, y+h] 一股脑塞进四个候选数组，
 *    于是选区左边缘会吸到窗口的 top 值、上边缘会吸到窗口的 left 值。
 */

import { describe, it, expect } from "vitest";
import {
  applyMagnet,
  eraseHits,
  pointHitAnnot,
  toLocalRect,
  toScreenPt,
  MAGNET_T,
} from "@/lib/screenshot/geometry";
import type { Annotation, ScreenInfo } from "@/lib/screenshot/types";

const screenAt = (originX: number, originY: number): ScreenInfo => ({
  dataUrl: "",
  originX,
  originY,
  width: 1920,
  height: 1080,
});

describe("坐标系换算", () => {
  it("单显示器（origin 为 0）时两个坐标系重合", () => {
    const s = screenAt(0, 0);
    expect(toScreenPt(s, 100, 200)).toEqual([100, 200]);
    expect(toLocalRect(s, { x: 100, y: 200, w: 30, h: 40 })).toEqual({
      x: 100,
      y: 200,
      w: 30,
      h: 40,
    });
  });

  it("副屏在主屏左边（origin 为负）时必须换算——这正是单屏测不出来的那个 bug", () => {
    const s = screenAt(-1920, -200);
    // 底图局部 (0,0) 对应屏幕坐标 (-1920,-200)
    expect(toScreenPt(s, 0, 0)).toEqual([-1920, -200]);
    expect(toScreenPt(s, 100, 50)).toEqual([-1820, -150]);
    // 后端返回的屏幕坐标矩形要换回局部
    expect(toLocalRect(s, { x: -1820, y: -150, w: 10, h: 10 })).toEqual({
      x: 100,
      y: 50,
      w: 10,
      h: 10,
    });
  });

  it("换去换回后与原值一致", () => {
    const s = screenAt(-1920, -200);
    const [sx, sy] = toScreenPt(s, 321, 654);
    expect(toLocalRect(s, { x: sx, y: sy, w: 1, h: 1 })).toMatchObject({ x: 321, y: 654 });
  });

  it("screen 为 null 时当作 origin=(0,0)，不抛错", () => {
    expect(toScreenPt(null, 5, 6)).toEqual([5, 6]);
    expect(toLocalRect(null, { x: 5, y: 6, w: 1, h: 2 })).toEqual({ x: 5, y: 6, w: 1, h: 2 });
  });
});

describe("applyMagnet", () => {
  const SW = 1000;
  const SH = 800;

  it("选区左边缘不会被参照窗口的 **y 边** 吸走", () => {
    // 参照矩形的 y=33 是个诱饵：选区 x=30 离它只有 3px，但 33 是垂直方向的值，
    // 水平吸附绝不能用它。bug 版会把 x 吸到 33。
    const ref = { x: 500, y: 33, w: 100, h: 100 };
    const out = applyMagnet({ x: 30, y: 300, w: 200, h: 100 }, [ref], SW, SH);
    expect(out.x).toBe(30);
  });

  it("选区上边缘不会被参照窗口的 **x 边** 吸走", () => {
    // 对称的反向用例：参照矩形 x=305，选区 y=302 离它 3px
    const ref = { x: 305, y: 700, w: 100, h: 50 };
    const out = applyMagnet({ x: 100, y: 302, w: 200, h: 100 }, [ref], SW, SH);
    expect(out.y).toBe(302);
  });

  it("同方向的边缘靠近时正常吸附", () => {
    const ref = { x: 500, y: 200, w: 100, h: 100 };
    // x=497 距离 ref.x=500 为 3 → 吸附
    expect(applyMagnet({ x: 497, y: 400, w: 50, h: 50 }, [ref], SW, SH).x).toBe(500);
    // y=203 距离 ref.y=200 为 3 → 吸附
    expect(applyMagnet({ x: 50, y: 203, w: 50, h: 50 }, [ref], SW, SH).y).toBe(200);
  });

  it("吸附屏幕边与中心线", () => {
    expect(applyMagnet({ x: 3, y: 400, w: 100, h: 50 }, [], SW, SH).x).toBe(0);
    // 中心线 x = 500
    expect(applyMagnet({ x: 503, y: 400, w: 100, h: 50 }, [], SW, SH).x).toBe(500);
  });

  it("超出阈值就不吸", () => {
    const far = MAGNET_T + 1;
    expect(applyMagnet({ x: far, y: 400, w: 100, h: 50 }, [], SW, SH).x).toBe(far);
  });

  it("吸附后宽高不会小于 4", () => {
    const out = applyMagnet({ x: 2, y: 2, w: 1, h: 1 }, [], SW, SH);
    expect(out.w).toBeGreaterThanOrEqual(4);
    expect(out.h).toBeGreaterThanOrEqual(4);
  });
});

describe("pointHitAnnot", () => {
  const base = { id: 1, color: "#f00", width: 3 };

  it("矩形：框内命中，远处不命中", () => {
    const a: Annotation = { ...base, type: "rect", x: 10, y: 10, x2: 110, y2: 60 };
    expect(pointHitAnnot(50, 30, a)).toBe(true);
    expect(pointHitAnnot(500, 30, a)).toBe(false);
  });

  it("矩形：坐标反向（x2 < x）也能命中", () => {
    const a: Annotation = { ...base, type: "rect", x: 110, y: 60, x2: 10, y2: 10 };
    expect(pointHitAnnot(50, 30, a)).toBe(true);
  });

  it("箭头：按点到线段距离判定，包围盒角落不算命中", () => {
    const a: Annotation = { ...base, type: "arrow", x: 0, y: 0, x2: 100, y2: 100 };
    expect(pointHitAnnot(50, 50, a)).toBe(true); // 线上
    expect(pointHitAnnot(0, 100, a)).toBe(false); // 包围盒角落，离线很远
  });

  it("序号：圆形命中", () => {
    const a: Annotation = { ...base, type: "number", x: 100, y: 100, x2: 100, y2: 100, size: 18 };
    expect(pointHitAnnot(113, 113, a)).toBe(true); // 圆心附近
    expect(pointHitAnnot(160, 160, a)).toBe(false);
  });

  it("画笔：靠近任一描点即命中；无描点时不命中", () => {
    const a: Annotation = {
      ...base,
      type: "pen",
      x: 0,
      y: 0,
      x2: 0,
      y2: 0,
      points: [
        [10, 10],
        [200, 200],
      ],
    };
    expect(pointHitAnnot(12, 12, a)).toBe(true);
    expect(pointHitAnnot(100, 100, a)).toBe(false);
    expect(pointHitAnnot(12, 12, { ...a, points: undefined })).toBe(false);
  });

  it("文字：包围盒为零，只靠 padding——所以长文本只能点左上角（已知局限）", () => {
    const a: Annotation = {
      ...base,
      type: "text",
      x: 100,
      y: 100,
      x2: 100,
      y2: 100,
      text: "很长很长的一段标注文字",
    };
    expect(pointHitAnnot(103, 103, a)).toBe(true);
    // 文字实际渲染到右侧很远，但命中框没跟上
    expect(pointHitAnnot(200, 103, a)).toBe(false);
  });
});

describe("eraseHits", () => {
  const mk = (id: number, x: number): Annotation => ({
    id,
    type: "rect",
    color: "#f00",
    width: 3,
    x,
    y: 0,
    x2: x + 20,
    y2: 20,
  });

  it("返回擦除路径经过的元素 id，且不重复", () => {
    const annots = [mk(1, 0), mk(2, 100), mk(3, 200)];
    const hits = eraseHits(
      [
        [5, 5],
        [8, 8],
        [105, 5],
      ],
      annots,
    );
    expect(hits.sort()).toEqual([1, 2]);
  });

  it("路径没碰到任何元素时返回空", () => {
    expect(eraseHits([[900, 900]], [mk(1, 0)])).toEqual([]);
  });
});
