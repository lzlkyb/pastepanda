import { describe, expect, it } from "vitest";
import {
  layoutSidePanel,
  layoutBand,
  PANEL_GAP,
  PANEL_MIN_H,
  BAND_BOTTOM,
  BAND_LIFT_GAP,
} from "@/lib/screenshot/panelPos";

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

describe("layoutSidePanel · 避让（矩形数组）", () => {
  // 窄选区时工具栏退化为左对齐并向右伸出选区，才会与面板相撞
  const narrowSel = { x: 300, y: 200, w: 120, h: 100 };
  const toolbar = { x: 300, y: 308, w: 620, h: 54 };

  it("右侧被工具栏压得放不下时，改到左侧而不是硬挤", () => {
    // 窄矮选区：右侧可用高度只有选区那么高（工具栏就在选区下方 8px），压完不够用；
    // 左侧则完全避开了向右伸出的工具栏，能拿到完整高度。
    const r = layoutSidePanel(narrowSel, W, VW, VH, [toolbar]);
    expect(r.side).toBe("left");
    expect(r.maxHeight).toBeGreaterThanOrEqual(PANEL_MIN_H);
    // 左侧与工具栏水平不相交，所以不该被压
    expect(r.left + W).toBeLessThanOrEqual(toolbar.x);
  });

  it("水平不相交时不压缩（工具栏右对齐宽选区的常规情形）", () => {
    const wideSel = { x: 200, y: 200, w: 800, h: 300 };
    const tb = { x: 380, y: 508, w: 620, h: 54 }; // 右边缘 = 选区右边缘
    const withAvoid = layoutSidePanel(wideSel, W, VW, VH, [tb]);
    const without = layoutSidePanel(wideSel, W, VW, VH, []);
    expect(withAvoid.maxHeight).toBe(without.maxHeight);
  });

  it("空间被压到小于最小高度时不再让，宁可盖住工具栏", () => {
    const sel = { x: 300, y: 200, w: 120, h: 100 };
    const tb = { x: 300, y: 240, w: 620, h: 54 }; // 紧贴选区顶部下方
    const r = layoutSidePanel(sel, W, VW, VH, [tb]);
    expect(r.maxHeight).toBeGreaterThanOrEqual(PANEL_MIN_H);
  });

  it("数组里的每个矩形各压一次：抽屉尾不再整条盖住底部带", () => {
    // 审计 §3 的实测回归位：1366×768 + 左下框时，底部带就在选区下方 16px，
    // 旧签名只躲工具栏，抽屉 62vh 的高度直接压过整条带（190~201×80）。
    const vw = 1366;
    const vh = 768;
    const sel = { x: 40, y: Math.round(vh * 0.74), w: Math.round(vw * 0.4), h: Math.round(vh * 0.18) };
    const band = { x: 533, y: vh - 16 - 30, w: 300, h: 30 };
    const r = layoutSidePanel(sel, W, vw, vh, [band]);
    // 带子与抽屉水平相交（抽屉贴选区右外侧），所以底边必须停在带子顶边之上
    const overlapsX = !(r.left + W <= band.x || r.left >= band.x + band.w);
    if (overlapsX) expect(r.top + r.maxHeight).toBeLessThanOrEqual(band.y - PANEL_GAP);
    // 全不够时兜底仍是 PANEL_MIN_H 语义（审计稿写明了 7~11px 残留，不是本次偷改）
    expect(r.maxHeight).toBeGreaterThanOrEqual(PANEL_MIN_H);
  });

  it("null 项跳过：调用方没有属性条时不必构造假矩形", () => {
    const sel = { x: 200, y: 260, w: 600, h: 400 };
    const tb = { x: 380, y: 668, w: 620, h: 54 };
    const a = layoutSidePanel(sel, W, VW, VH, [null, tb]);
    const b = layoutSidePanel(sel, W, VW, VH, [tb]);
    expect(a).toEqual(b);
  });

  // ---- AI 动作面板（截图整改 B 档）新增的两个选项 ----
  // 默认值必须保持 OCR 抽屉的老行为，所以上面所有用例都不传 opts。

  const POP_W = 320;

  it("pick: tallest 换到高度更大的那一侧（first 不会）", () => {
    const vw = 1366;
    const vh = 768;
    const sel = { x: 400, y: 300, w: 300, h: 300 };
    // 标注工具栏在选区下方、向右伸出选区右缘：贴右侧的候选被它压掉一截
    const tb = { x: 430, y: 610, w: 907, h: 54 };
    const first = layoutSidePanel(sel, POP_W, vw, vh, [tb]);
    const tallest = layoutSidePanel(sel, POP_W, vw, vh, [tb], PANEL_GAP, { pick: "tallest" });
    expect(first.side).toBe("right");
    expect(tallest.side).toBe("left");
    expect(tallest.maxHeight).toBeGreaterThan(first.maxHeight);
    // 左侧与工具栏水平不相交 → 拿到的是「到屏幕底」的完整高度而不是被压后的值
    expect(tallest.maxHeight).toBe(vh - PANEL_GAP - sel.y);
    expect(first.maxHeight).toBe(610 - PANEL_GAP - sel.y);
  });

  it("pick: tallest 同高时仍按右→左优先级（不为 1px 跳边）", () => {
    const sel = { x: 400, y: 100, w: 300, h: 300 };
    const a = layoutSidePanel(sel, POP_W, 1366, 768, [], PANEL_GAP, { pick: "tallest" });
    expect(a.side).toBe("right");
  });

  it("maxVH 同时压比较尺和应用值：截断后两边都够就不跳边", () => {
    const vh = 1080;
    const sel = { x: 400, y: 100, w: 300, h: 200 };
    // 右侧被低处的矩形压到 792、左侧仍是 972 —— 未截断时差 180px，但两者都超过
    // 0.42 上限。比较必须用截断后的高度，否则 tallest 会为了这点差异跳到左侧。
    const low = { x: sel.x + sel.w + PANEL_GAP, y: 900, w: 400, h: 40 };
    const r = layoutSidePanel(sel, POP_W, 1920, vh, [low], PANEL_GAP, {
      pick: "tallest",
      maxVH: 0.42,
    });
    expect(r.maxHeight).toBe(Math.round(vh * 0.42));
    expect(r.side).toBe("right");
  });

  it("cover 语义（avoid 只喂底部带）：面板可以压工具栏，但不压带子", () => {
    const vw = 1366;
    const vh = 768;
    const sel = { x: 400, y: 300, w: 300, h: 300 };
    // 工具栏横跨两侧候选（真机上它比选区宽得多），底部带在屏幕底
    const tb = { x: 100, y: 610, w: 907, h: 54 };
    const band = { x: 533, y: vh - 16 - 30, w: 300, h: 30 };
    const cover = layoutSidePanel(sel, POP_W, vw, vh, [band], PANEL_GAP, {
      pick: "tallest",
      maxVH: 0.42,
    });
    const avoidTb = layoutSidePanel(sel, POP_W, vw, vh, [band, tb], PANEL_GAP, {
      pick: "tallest",
      maxVH: 0.42,
    });
    // cover 档拿到满高，因此底边会越过工具栏顶边 —— 这是拍板过的取舍
    expect(cover.maxHeight).toBeGreaterThan(avoidTb.maxHeight);
    expect(cover.top + cover.maxHeight).toBeGreaterThan(tb.y);
    // 两种都不得压住底部带
    for (const r of [cover, avoidTb]) {
      const overlapsX = !(r.left + POP_W <= band.x || r.left >= band.x + band.w);
      if (overlapsX) expect(r.top + r.maxHeight).toBeLessThanOrEqual(band.y - PANEL_GAP);
    }
  });
});

describe("layoutBand · 底部带只有一档静息位", () => {
  it("没有遮挡时贴屏幕底 16px，水平居中", () => {
    const r = layoutBand(VW, VH, 300, 30, []);
    expect(r.bottom).toBe(BAND_BOTTOM);
    expect(r.left).toBe(Math.round((VW - 300) / 2));
  });

  it("水平不相交就不抬：带子不该为了躲侧边面板乱跳", () => {
    const panel = { x: VW - 300, y: VH - 400, w: W, h: 300 };
    expect(layoutBand(VW, VH, 300, 30, [panel]).bottom).toBe(BAND_BOTTOM);
  });

  it("被挡住才抬，且抬到遮挡物上缘之上留 8px", () => {
    // 属性条压在带子的静息位上（贴屏幕底的矮选区）
    const ab = { x: 600, y: VH - 60, w: 435, h: 34 };
    const r = layoutBand(VW, VH, 300, 30, [ab]);
    expect(r.bottom).toBe(VH - ab.y + BAND_LIFT_GAP);
    expect(VH - r.bottom - 30).toBeLessThanOrEqual(ab.y - BAND_LIFT_GAP);
  });

  it("垂直不相交（遮挡物在带子下方）不抬：只抬不降", () => {
    // 属性条翻到选区内部底边时可能整条落在带子静息位之下，这时 16px 就是对的
    const below = { x: 600, y: VH - 8, w: 435, h: 8 };
    expect(layoutBand(VW, VH, 300, 30, [below]).bottom).toBe(BAND_BOTTOM);
  });

  it("迭代到稳定：抬过属性条后不再撞工具栏", () => {
    // 属性条在带子静息位上，工具栏又正好在属性条上方 —— 单趟只躲属性条会撞上工具栏
    const ab = { x: 583, y: VH - 60, w: 435, h: 34 };
    const tb = { x: 583, y: VH - 102, w: 620, h: 54 };
    const r = layoutBand(VW, VH, 300, 30, [ab, tb]);
    const top = VH - r.bottom - 30;
    for (const rect of [ab, tb]) {
      const overlapsX = !(r.left + 300 <= rect.x || r.left >= rect.x + rect.w);
      if (overlapsX && top < rect.y + rect.h && top + 30 > rect.y) {
        throw new Error(`带子仍与遮挡物相交：top=${top}, rect=${JSON.stringify(rect)}`);
      }
    }
    expect(top).toBeLessThanOrEqual(tb.y - BAND_LIFT_GAP);
  });
});
