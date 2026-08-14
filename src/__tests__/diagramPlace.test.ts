/**
 * 浮层定位的边界行为（属性浮岛 / 右键菜单共用的 placeAnchored / placeMenu）。
 *
 * 这类算错不会报错，只是浮层静悄悄跑到画布外、或者尖角指错方向，
 * 靠肉眼很容易漏——尤其是 402px 紧凑档那种“永远在边界上”的尺寸。
 */
import { describe, it, expect } from "vitest";
import { placeAnchored, placeMenu, EDGE_MARGIN, ANCHOR_GAP } from "@/components/editors/diagram/chrome/place";

/** 宽档真实画布（窗口≥957 时的内嵌弹窗） */
const ROOMY = { width: 840, height: 470 };
/** 紧凑档真实画布（默认 480px 窗口） */
const COMPACT = { width: 402, height: 390 };
/** 浮岛实测尺寸：11 个按钮 + 3 个分隔线的一排 */
const ISLAND = { width: 330, height: 39 };

describe("placeAnchored（属性浮岛）", () => {
  it("空间够时摆在节点上方、水平居中", () => {
    const anchor = { left: 400, top: 200, width: 120, height: 44 };
    const p = placeAnchored(anchor, ISLAND, ROOMY);
    expect(p.below).toBe(false);
    expect(p.top).toBe(200 - ISLAND.height - ANCHOR_GAP);
    // 节点中心 460，浮岛半宽 165 → 295
    expect(p.left).toBe(295);
  });

  it("节点贴顶时翻到下方，below 为 true（尖角靠它改方向）", () => {
    const anchor = { left: 400, top: 6, width: 120, height: 44 };
    const p = placeAnchored(anchor, ISLAND, ROOMY);
    expect(p.below).toBe(true);
    expect(p.top).toBe(6 + 44 + ANCHOR_GAP);
  });

  it("节点靠左边时钳到最小留白，不会负数出界", () => {
    const p = placeAnchored({ left: 0, top: 200, width: 96, height: 44 }, ISLAND, ROOMY);
    expect(p.left).toBe(EDGE_MARGIN);
  });

  it("节点靠右边时钳到右侧留白内", () => {
    const p = placeAnchored({ left: 800, top: 200, width: 96, height: 44 }, ISLAND, ROOMY);
    expect(p.left).toBe(ROOMY.width - ISLAND.width - EDGE_MARGIN);
  });

  it("节点在底部且上方也放不下时，竖向仍被钳在画布内", () => {
    // 节点几乎占满整个画布高：上方放不下→翻下方→下方也出底→钳回来
    const p = placeAnchored({ left: 400, top: 4, width: 120, height: 380 }, ISLAND, COMPACT);
    expect(p.top).toBeLessThanOrEqual(COMPACT.height - ISLAND.height - EDGE_MARGIN);
    expect(p.top).toBeGreaterThanOrEqual(EDGE_MARGIN);
  });

  it("容器比浮岛还窄时贴左上角，不返回比留白还小的值", () => {
    // 窗口拉到 minWidth 320 时画布只有 248px，比 330px 的浮岛还窄
    const p = placeAnchored({ left: 100, top: 200, width: 96, height: 44 }, ISLAND, { width: 248, height: 360 });
    expect(p.left).toBe(EDGE_MARGIN);
  });
});

describe("placeMenu（右键菜单）", () => {
  const MENU = { width: 168, height: 220 };

  it("空间够时就摆在鼠标点右下", () => {
    const p = placeMenu({ x: 100, y: 60 }, MENU, ROOMY);
    expect(p).toEqual({ left: 100, top: 60 });
  });

  it("右侧越界时向左翻（而不是硬贴右边）", () => {
    // 贴边会盖住鼠标下方的内容，而用户刚右键的就是那个位置
    const p = placeMenu({ x: 380, y: 60 }, MENU, COMPACT);
    expect(p.left).toBe(380 - MENU.width);
  });

  it("底部越界时向上翻", () => {
    const p = placeMenu({ x: 100, y: 340 }, MENU, COMPACT);
    expect(p.top).toBe(340 - MENU.height);
  });

  it("右下角同时越界时两个方向都翻", () => {
    const p = placeMenu({ x: 390, y: 380 }, MENU, COMPACT);
    expect(p.left).toBe(390 - MENU.width);
    expect(p.top).toBe(380 - MENU.height);
  });

  it("翻完仍越界（菜单比画布高）时钳在留白内", () => {
    const tall = { width: 168, height: 500 };
    const p = placeMenu({ x: 100, y: 380 }, tall, COMPACT);
    expect(p.top).toBe(EDGE_MARGIN);
  });
});
