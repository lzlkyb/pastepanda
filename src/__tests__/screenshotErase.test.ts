import { describe, expect, it } from "vitest";
import { eraseStrokes } from "@/lib/screenshot/geometry";
import type { Annotation } from "@/lib/screenshot/types";

/** 造一条水平笔迹：y 固定，x 从 0 递增 */
function pen(id: number, n = 10, y = 100, step = 10): Annotation {
  return {
    id,
    type: "pen",
    color: "#ef4444",
    width: 3,
    x: 0,
    y,
    x2: (n - 1) * step,
    y2: y,
    points: Array.from({ length: n }, (_, i) => [i * step, y] as [number, number]),
  };
}

function rect(id: number): Annotation {
  return { id, type: "rect", color: "#ef4444", width: 3, x: 500, y: 500, x2: 600, y2: 600 };
}

describe("eraseStrokes · 真橡皮擦", () => {
  it("擦中间：一条笔迹切成两段", () => {
    const p = pen(1); // 点在 x = 0,10,...,90
    // 擦 x=40、5 半径只盖住那一个点
    const r = eraseStrokes([[40, 100]], [p], 5);
    expect(r.deleted).toEqual([1]);
    expect(r.split).toHaveLength(2);
    expect(r.split[0].points).toEqual([
      [0, 100],
      [10, 100],
      [20, 100],
      [30, 100],
    ]);
    expect(r.split[1].points).toEqual([
      [50, 100],
      [60, 100],
      [70, 100],
      [80, 100],
      [90, 100],
    ]);
  });

  it("切分后的新段保留颜色/类型/粗细，且包围盒跟着更新", () => {
    const p = pen(1);
    const r = eraseStrokes([[40, 100]], [p], 5);
    for (const s of r.split) {
      expect(s.type).toBe("pen");
      expect(s.color).toBe("#ef4444");
      expect(s.width).toBe(3);
    }
    // 包围盒必须重算：不算的话命中检测/选中框还按原整条笔迹的范围走，
    // 用户会在空白处点中一条已经被擦掉的线。
    expect(r.split[0].x).toBe(0);
    expect(r.split[0].x2).toBe(30);
    expect(r.split[1].x).toBe(50);
    expect(r.split[1].x2).toBe(90);
  });

  it("擦头部：只剩一段，不会留下空段", () => {
    const p = pen(1);
    const r = eraseStrokes(
      [
        [0, 100],
        [10, 100],
      ],
      [p],
      5,
    );
    expect(r.split).toHaveLength(1);
    expect(r.split[0].points?.[0]).toEqual([20, 100]);
  });

  it("全部擦掉：只有 deleted，没有新段", () => {
    const p = pen(1, 3);
    const r = eraseStrokes(
      [
        [0, 100],
        [10, 100],
        [20, 100],
      ],
      [p],
      5,
    );
    expect(r.deleted).toEqual([1]);
    expect(r.split).toHaveLength(0);
  });

  it("一点都没擦到：原封不动（不能白白重建成新 id）", () => {
    // 重建会让原标注的选中状态、z 序无缘无故变化
    const p = pen(1);
    const r = eraseStrokes([[9999, 9999]], [p], 5);
    expect(r.deleted).toHaveLength(0);
    expect(r.split).toHaveLength(0);
  });

  it("碎段丢弃：只剩 1 个点的段不保留", () => {
    // 擦掉 x=10 和 x=30，中间只剩 x=20 单点 → 应丢弃
    const p = pen(1, 5); // 0,10,20,30,40
    const r = eraseStrokes(
      [
        [10, 100],
        [30, 100],
      ],
      [p],
      5,
    );
    const lens = r.split.map((s) => s.points?.length);
    expect(lens).not.toContain(1);
    // 头尾也各只剩 1 点（x=0 和 x=40），全部丢弃
    expect(r.split).toHaveLength(0);
    expect(r.deleted).toEqual([1]);
  });

  it("矩形等非笔迹类：碰到就整删，不会产生切分段", () => {
    const r = eraseStrokes([[550, 550]], [rect(7)], 5);
    expect(r.deleted).toEqual([7]);
    expect(r.split).toHaveLength(0);
  });

  it("拖矩形的马赛克算非笔迹（shape 缺省 = rect）：整删", () => {
    const mosaic: Annotation = {
      id: 3, type: "mosaic", color: "#ef4444", width: 3,
      x: 100, y: 100, x2: 200, y2: 200,
    };
    const r = eraseStrokes([[150, 150]], [mosaic], 5);
    expect(r.deleted).toEqual([3]);
    expect(r.split).toHaveLength(0);
  });

  it("涂抹的马赛克算笔迹：可以被切分", () => {
    const brush: Annotation = {
      ...pen(4),
      type: "mosaic",
      shape: "brush",
      strength: 8,
    };
    const r = eraseStrokes([[40, 100]], [brush], 5);
    expect(r.split).toHaveLength(2);
    // 切分后仍然是涂抹马赛克，强度跟着走
    expect(r.split[0].type).toBe("mosaic");
    expect(r.split[0].shape).toBe("brush");
    expect(r.split[0].strength).toBe(8);
  });

  it("多个标注混合：各自按自己的规则处理", () => {
    const p = pen(1);
    const rc = rect(2);
    const untouched = pen(3, 5, 800); // 离得很远
    const r = eraseStrokes([[40, 100], [550, 550]], [p, rc, untouched], 5);
    expect(r.deleted.sort()).toEqual([1, 2]);
    expect(r.split).toHaveLength(2); // 只来自 p
  });

  it("半径变大：能一次擦掉更多点", () => {
    const p = pen(1); // 间距 10
    const small = eraseStrokes([[40, 100]], [p], 5);
    const big = eraseStrokes([[40, 100]], [p], 15);
    const smallKept = small.split.reduce((n, s) => n + (s.points?.length ?? 0), 0);
    const bigKept = big.split.reduce((n, s) => n + (s.points?.length ?? 0), 0);
    expect(bigKept).toBeLessThan(smallKept);
  });
});
