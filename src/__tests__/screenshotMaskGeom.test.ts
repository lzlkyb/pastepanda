import { describe, expect, it } from "vitest";
import {
  MASK_BRUSH_SCALE,
  isRowMasked,
  maskBox,
  maskBrushWidth,
} from "@/lib/screenshot/maskGeom";
import type { Annotation, ToolId } from "@/lib/screenshot/types";

/** 矩形形态的遮罩标注 */
function rectMask(type: ToolId, x: number, y: number, x2: number, y2: number): Annotation {
  return { id: 1, type, color: "#ef4444", width: 3, x, y, x2, y2 };
}

/** 涂抹形态的遮罩标注 */
function brushMask(type: ToolId, points: [number, number][], width = 2): Annotation {
  return {
    id: 1,
    type,
    color: "#ef4444",
    width,
    shape: "brush",
    points,
    x: points[0][0],
    y: points[0][1],
    x2: points[points.length - 1][0],
    y2: points[points.length - 1][1],
  };
}

describe("maskBrushWidth · 遮罩笔刷宽度", () => {
  it("三个线宽档位各自放大 8 倍", () => {
    // WIDTHS 是 2/3/5 物理像素（给描边用的），当涂抹笔刷太细
    expect(maskBrushWidth(brushMask("mosaic", [[0, 0]], 2))).toBe(16);
    expect(maskBrushWidth(brushMask("mosaic", [[0, 0]], 3))).toBe(24);
    expect(maskBrushWidth(brushMask("mosaic", [[0, 0]], 5))).toBe(40);
  });

  it("有 12px 下限（防将来档位调到 1）", () => {
    expect(maskBrushWidth(brushMask("mosaic", [[0, 0]], 1))).toBe(12);
  });

  it("倍数常量导出供其他模块对齐，不要各自写魔术数", () => {
    expect(MASK_BRUSH_SCALE).toBe(8);
  });
});

describe("maskBox · 包围盒", () => {
  it("涂抹：向外扩半个**笔刷**宽（不是半个线宽）", () => {
    // width=3 → 笔刷 24 → 每边扩 12。
    // 这条钉的是“扩边必须跟描边同宽”：若还按 a.width 扩 1.5，
    // 离屏层就只有 3px 宽，24px 的笔刷会被裁成一条细线。
    const b = maskBox(brushMask("mosaic", [[100, 100]], 3));
    expect(b).toEqual({ x: 88, y: 88, w: 24, h: 24 });
  });

  it("涂抹：多点取路径包围盒再扩边", () => {
    const b = maskBox(brushMask("blur", [[100, 100], [200, 140]], 2));
    // bw=16，r=8：x 100-8=92、w 100+16=116
    expect(b).toEqual({ x: 92, y: 92, w: 116, h: 56 });
  });

  it("矩形形态：就是拖出来的矩形，与笔宽无关", () => {
    expect(maskBox(rectMask("mosaic", 10, 20, 110, 70))).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it("反向拖的矩形也归一", () => {
    expect(maskBox(rectMask("mosaic", 110, 70, 10, 20))).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it("shape 缺省当 rect（旧标注回归）", () => {
    // 当成 brush 会因为没有 points 而算出一堆 Infinity，旧标注会默默消失
    const legacy: Annotation = { id: 1, type: "mosaic", color: "#000", width: 3, x: 0, y: 0, x2: 50, y2: 30 };
    expect(maskBox(legacy)).toEqual({ x: 0, y: 0, w: 50, h: 30 });
  });

  it("标为 brush 但 points 为空时退回矩形，不算出 Infinity", () => {
    const weird: Annotation = {
      id: 1, type: "mosaic", color: "#000", width: 3, shape: "brush", points: [], x: 0, y: 0, x2: 40, y2: 20,
    };
    expect(maskBox(weird)).toEqual({ x: 0, y: 0, w: 40, h: 20 });
  });
});

describe("isRowMasked · OCR 行是否被遮罩盖住", () => {
  const row = { x: 100, y: 100, w: 200, h: 20 };

  it("没有任何标注", () => {
    expect(isRowMasked(row, [])).toBe(false);
  });

  it("矩形马赛克盖住整行", () => {
    expect(isRowMasked(row, [rectMask("mosaic", 50, 90, 400, 130)])).toBe(true);
  });

  it("矩形模糊只盖住行尾一小段 → 仍然算被遮", () => {
    // 这条是安全语义：复制的粒度是整行，行尾的手机号被盖住也不能让整行可点
    expect(isRowMasked(row, [rectMask("blur", 280, 105, 320, 115)])).toBe(true);
  });

  it("完全不相交", () => {
    expect(isRowMasked(row, [rectMask("mosaic", 0, 0, 50, 50)])).toBe(false);
  });

  it("只是共边不算盖住", () => {
    // 马赛克右边缘正好落在行的左边缘上，一个像素都没盖住
    expect(isRowMasked(row, [rectMask("mosaic", 0, 100, 100, 120)])).toBe(false);
  });

  it("高亮**不算**遮蔽", () => {
    // 荧光笔盖上去文字照样可读（multiply），把它当遮蔽会让高亮过的行变成不可点
    expect(isRowMasked(row, [rectMask("highlight", 50, 90, 400, 130)])).toBe(false);
    expect(isRowMasked(row, [brushMask("highlight", [[150, 110]])])).toBe(false);
  });

  it("画笔 / 矩形 / 文字等非遮罩类不算遮蔽", () => {
    expect(isRowMasked(row, [brushMask("pen", [[150, 110]])])).toBe(false);
    expect(isRowMasked(row, [rectMask("rect", 50, 90, 400, 130)])).toBe(false);
    expect(isRowMasked(row, [rectMask("text", 50, 90, 400, 130)])).toBe(false);
  });

  it("涂抹：采样点落在行里", () => {
    expect(isRowMasked(row, [brushMask("mosaic", [[150, 110], [160, 112]])])).toBe(true);
  });

  it("涂抹：采样点在行外但落在半个笔宽内", () => {
    // width=2 → 笔刷 16，半宽 8：笔心在行上方 6px 处，笔边已经压到行了
    expect(isRowMasked(row, [brushMask("mosaic", [[150, 94]])])).toBe(true);
  });

  it("涂抹：两个采样点都在行外、连线却横穿整行 → 算被遮", () => {
    // 这条钉 Liang-Barsky：mousemove 一次能跳几十像素，只判采样点会漏。
    // x=50 与 x=400 都在膨胀后的 [92,308] 之外，但连线 y=110 横穿整行。
    expect(isRowMasked(row, [brushMask("mosaic", [[50, 110], [400, 110]])])).toBe(true);
  });

  it("涂抹：斜着穿过也算", () => {
    expect(isRowMasked(row, [brushMask("mosaic", [[50, 50], [400, 200]])])).toBe(true);
  });

  it("涂抹：连线从行上方横过，没碰到行", () => {
    expect(isRowMasked(row, [brushMask("mosaic", [[50, 40], [400, 40]])])).toBe(false);
  });

  it("多个标注时只要有一个盖到就算", () => {
    const annots = [
      rectMask("mosaic", 0, 0, 10, 10),
      brushMask("blur", [[150, 110]]),
    ];
    expect(isRowMasked(row, annots)).toBe(true);
  });
});
