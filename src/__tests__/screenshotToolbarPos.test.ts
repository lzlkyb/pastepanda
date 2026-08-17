import { describe, expect, it } from "vitest";
import { layoutToolbar, TB_ATTR_GAP, TB_GAP } from "@/lib/screenshot/toolbarPos";

/**
 * 工具栏定位。重点盯四个旧实现碎掉的场景：
 * ① 水平不跟选区（旧实现 CSS 写死 left:50%）
 * ② 上下都放不下时钳到 top=8 压住画面顶部
 * ③ 选区比工具栏窄
 * ④ 属性条夹在工具栏和选区之间遮住画面
 */

const TB_W = 620;
const TB_H = 46;
const ATTR_H = 34;
const VW = 1920;
const VH = 1080;

describe("layoutToolbar · 水平对齐", () => {
  it("选区比工具栏宽：右边缘对齐选区右边缘", () => {
    const sel = { x: 400, y: 200, w: 900, h: 300 };
    const r = layoutToolbar(sel, TB_W, TB_H, 0, VW, VH);
    expect(r.left + TB_W).toBe(sel.x + sel.w);
  });

  it("选区比工具栏窄：退化为左对齐选区左边缘，不把栏推到选区左侧老远", () => {
    const sel = { x: 800, y: 200, w: 120, h: 60 };
    const r = layoutToolbar(sel, TB_W, TB_H, 0, VW, VH);
    expect(r.left).toBe(sel.x);
    // 右对齐的话 left 会是 920-620=300，比选区左边还左 500px
    expect(r.left).toBeGreaterThan(sel.x + sel.w - TB_W);
  });

  it("选区贴屏幕右边：向内钳，不超出右边界", () => {
    const sel = { x: 1500, y: 200, w: 420, h: 300 };
    const r = layoutToolbar(sel, TB_W, TB_H, 0, VW, VH);
    expect(r.left + TB_W).toBeLessThanOrEqual(VW - TB_GAP);
  });

  it("选区贴屏幕左边：不超出左边界", () => {
    const sel = { x: 0, y: 200, w: 200, h: 300 };
    const r = layoutToolbar(sel, TB_W, TB_H, 0, VW, VH);
    expect(r.left).toBeGreaterThanOrEqual(TB_GAP);
  });

  // V6.21 反转：原本这条断言“保左”，理由是“左边是工具区”。
  // 那在当时成立（右端只有 取消/完成/⋯），但现在右端是 保存/贴图/AI/完成/更多，
  // 全是出口——截掉它们等于这次截图没有去向；而左端被截的标注工具还有 0-9 快捷键可用。
  it("工具栏宽于视口：保住右边可见（右边是出口区）", () => {
    const sel = { x: 10, y: 100, w: 200, h: 100 };
    const r = layoutToolbar(sel, 900, TB_H, 0, 800, VH);
    expect(r.left + 900).toBe(800 - TB_GAP);
    expect(r.left).toBeLessThan(TB_GAP); // 左边确实被推出视口
  });
});

describe("layoutToolbar · 垂直避让", () => {
  it("下方放得下：贴选区下方，attach=below", () => {
    const sel = { x: 400, y: 100, w: 900, h: 300 };
    const r = layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH);
    expect(r.attach).toBe("below");
    expect(r.top).toBe(sel.y + sel.h + TB_GAP);
  });

  it("下方放不下：翻到上方，attach=above", () => {
    // 选区底部贴屏幕底，但顶部留了足够空间
    const sel = { x: 400, y: 500, w: 900, h: 560 };
    const r = layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH);
    expect(r.attach).toBe("above");
    expect(r.top + TB_H).toBe(sel.y - TB_GAP);
  });

  it("上下都放不下：贴选区内部底边，而不是钳到顶部压住画面", () => {
    // 全屏选区：旧实现会得到 top=8（压在画面最顶端）
    const sel = { x: 0, y: 0, w: VW, h: VH };
    const r = layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH);
    expect(r.attach).toBe("inside");
    expect(r.top).toBe(VH - TB_GAP - TB_H);
    expect(r.top).toBeGreaterThan(VH / 2); // 关键：在下半屏，不是顶部
  });

  it("全屏选区下工具栏仍在视口内", () => {
    const sel = { x: 0, y: 0, w: VW, h: VH };
    const r = layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH);
    expect(r.top).toBeGreaterThanOrEqual(TB_GAP);
    expect(r.top + TB_H).toBeLessThanOrEqual(VH - TB_GAP);
  });
});

describe("layoutToolbar · 属性条总在远离选区一侧", () => {
  it("below：属性条在主栏下方", () => {
    const sel = { x: 400, y: 100, w: 900, h: 300 };
    const r = layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH);
    expect(r.attrTop).toBe(r.top + TB_H + TB_ATTR_GAP);
    expect(r.attrTop).toBeGreaterThan(r.top); // 远离选区
  });

  it("above：属性条在主栏上方，不夹在工具栏和选区之间", () => {
    const sel = { x: 400, y: 500, w: 900, h: 560 };
    const r = layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH);
    expect(r.attach).toBe("above");
    expect(r.attrTop + ATTR_H).toBe(r.top - TB_ATTR_GAP);
    expect(r.attrTop).toBeLessThan(r.top); // 在主栏上方 = 远离选区
  });

  it("above 时整个两层仍在视口内", () => {
    const sel = { x: 400, y: 500, w: 900, h: 560 };
    const r = layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH);
    expect(r.attrTop).toBeGreaterThanOrEqual(TB_GAP);
  });

  it("属性条不显示（attrH=0）时垂直判断只算主栏高度", () => {
    // 这个选区下方能放下主栏但放不下主栏+属性条
    const sel = { x: 400, y: 100, w: 900, h: VH - 100 - TB_GAP - TB_H - TB_GAP };
    expect(layoutToolbar(sel, TB_W, TB_H, 0, VW, VH).attach).toBe("below");
    expect(layoutToolbar(sel, TB_W, TB_H, ATTR_H, VW, VH).attach).not.toBe("below");
  });
  /* ===== 加宽后的工具栏（V6.21：保存 / 贴图 / AI 三个出口上升到主栏）=====
   * 主栏从约 770 涨到约 890 CSS 像素，所以要钉住两个宽度上的行为。 */

  it("890 宽的主栏在 1093 视口（1366×125%）里不溢出", () => {
    const WIDE = 890;
    const vw = 1093;
    // 选区贴屏幕右边缘：最容易把工具栏推出去的位置
    const sel = { x: vw - 300, y: 100, w: 300, h: 200 };
    const r = layoutToolbar(sel, WIDE, TB_H, ATTR_H, vw, VH);
    expect(r.left).toBeGreaterThanOrEqual(TB_GAP);
    expect(r.left + WIDE).toBeLessThanOrEqual(vw - TB_GAP);
  });

  it("主栏宽于视口时保住右端（出口区），左端可以被截", () => {
    // 反转过的兜底：右端现在是 保存/贴图/AI/完成/更多，全是出口，
    // 截掉它们等于这次截图没有去向；左端被截掉的是标注工具（还有 0-9 快捷键可用）。
    const WIDE = 890;
    const vw = 853; // 1280×150%
    const sel = { x: 100, y: 100, w: 300, h: 200 };
    const r = layoutToolbar(sel, WIDE, TB_H, ATTR_H, vw, VH);
    expect(r.left).toBeLessThan(TB_GAP); // 左边被推出视口
    expect(r.left + WIDE).toBe(vw - TB_GAP); // 右端仍然贴着可视区右边
  });
});
