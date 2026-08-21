/**
 * 菜单**定位**：贴近屏幕边缘时的翻折与钳制。
 *
 * jsdom 不做布局，offsetWidth/offsetHeight 恒为 0，所以这里桩掉它们 —— 桩的正是
 * 生产代码测量用的那两个属性（批 4 从 getBoundingClientRect 换成它们：入场动画带
 * scale 0.95，而 rect 是变换后的尺寸，动画期间会量小 5%）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useContext } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ContextMenu, CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";

const MENU_W = 200;
const MENU_H = 300;

const ITEMS: MenuItem[] = [{ icon: null, label: "复制到剪贴板", onClick: vi.fn() }];

function Harness({ x, y }: { x: number; y: number }) {
  const trigger = useContext(CtxMenuCtx);
  return <button onClick={() => trigger?.(x, y, ITEMS)}>开菜单</button>;
}

/** 打开菜单并读回它最终落在哪 */
function openAt(x: number, y: number): { left: number; top: number } {
  render(
    <ContextMenu>
      <Harness x={x} y={y} />
    </ContextMenu>,
  );
  fireEvent.click(screen.getByText("开菜单"));
  const el = screen.getByRole("menu");
  return {
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
  };
}

let descW: PropertyDescriptor | undefined;
let descH: PropertyDescriptor | undefined;

beforeEach(() => {
  cleanup();
  descW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  descH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: MENU_W });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: MENU_H });
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

afterEach(() => {
  if (descW) Object.defineProperty(HTMLElement.prototype, "offsetWidth", descW);
  if (descH) Object.defineProperty(HTMLElement.prototype, "offsetHeight", descH);
});

describe("菜单贴边翻折", () => {
  it("空间够时就贴着光标右下弹出", () => {
    expect(openAt(100, 100)).toEqual({ left: 100, top: 100 });
  });

  it("右边放不下且左边放得下 → 翻到光标左侧", () => {
    // x=950，右侧只剩 42px，左侧有 942px
    expect(openAt(950, 100).left).toBe(950 - MENU_W);
  });

  it("下边放不下且上边放得下 → 翻到光标上方", () => {
    expect(openAt(100, 780).top).toBe(780 - MENU_H);
  });

  it("两个方向都放不下 → 钳到边距内，不允许溢出视口", () => {
    const { left, top } = openAt(990, 790);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + MENU_W).toBeLessThanOrEqual(1000 - 8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + MENU_H).toBeLessThanOrEqual(800 - 8);
  });

  it("光标贴着左上角时不会被推成负坐标", () => {
    const { left, top } = openAt(0, 0);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it("视口比菜单还小时也不会算出负坐标（窄窗口）", () => {
    window.innerWidth = 150;
    window.innerHeight = 150;
    const { left, top } = openAt(75, 75);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
  });
});
