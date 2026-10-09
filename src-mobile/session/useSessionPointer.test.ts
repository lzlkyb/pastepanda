import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useSessionPointer } from "./useSessionPointer";
import type { TouchCallbacks } from "./touchClassifier";

const bindings = vi.hoisted(() => ({
  current: [] as { callbacks: TouchCallbacks; onDown: (x: number, y: number) => void }[],
  cancel: vi.fn(),
}));
vi.mock("./useTouchGestures", () => ({
  useTouchGestures: (props: (typeof bindings.current)[number]) => {
    bindings.current.push(props);
    return { cancelAll: bindings.cancel };
  },
}));
beforeEach(() => localStorage.clear());
function setup(canControl = true) {
  bindings.current = [];
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;
  const input = {
    norm: vi.fn(),
    queueMove: vi.fn(),
    sendClick: vi.fn(),
    dragDown: vi.fn(),
    dragUp: vi.fn(),
    scrollByFrame: vi.fn(),
    sendKeyPair: vi.fn(),
    sendKeyDown: vi.fn(),
    sendKeyUp: vi.fn(),
    sendText: vi.fn(),
    submitText: vi.fn(),
    sendRaw: vi.fn(),
    releaseAll: vi.fn(),
    sendFailed: false,
  };
  const releaseKeys = vi.fn();
  const feedback = { cursorOn: vi.fn(), ripple: vi.fn(), charge: vi.fn() };
  const viewport = { applyPinch: vi.fn(), reset: vi.fn(), getScale: () => 2, reveal: vi.fn() };
  const { result, unmount } = renderHook(() =>
    useSessionPointer({
      input,
      canvasRef: { current: canvas },
      contentRef: { current: { w: 1000, h: 500 } },
      surfaceRef: { current: null },
      viewportRef: { current: viewport },
      enabled: true,
      canControl,
      releaseKeys,
      feedback,
    }),
  );
  return { result, unmount, input, releaseKeys, feedback, viewport, binding: () => bindings.current[bindings.current.length - 2]!, pad: () => bindings.current[bindings.current.length - 1]! };
}
it("触控板点按落在指针处，划动按相对距离移动", () => {
  const h = setup(),
    b = h.binding();
  act(() => {
    b.onDown(100, 100);
    b.callbacks.onMoveTo(130, 120);
    b.callbacks.onTap(130, 120, false);
  });
  expect(h.input.queueMove.mock.calls[0][0]).toBeCloseTo(530, 0);
  expect(h.input.queueMove.mock.calls[0][1]).toBeCloseTo(270, 0);
  expect(h.input.sendClick.mock.calls[0][1]).toBeCloseTo(530, 0);
});

it("长按有预告，原位松手右键清除预告，双击使用独立视觉反馈", () => {
  const h = setup();
  act(() => h.binding().callbacks.onCharge(100, 100));
  expect(h.result.current.charging).toBe(true);
  expect(h.feedback.charge).toHaveBeenCalledWith("on", expect.any(Number), expect.any(Number));
  act(() => h.binding().callbacks.onRightClick(100, 100));
  expect(h.result.current.charging).toBe(false);
  expect(h.feedback.charge).toHaveBeenCalledWith("off");
  act(() => h.binding().callbacks.onTap(100, 100, true));
  expect(h.feedback.ripple).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), "big");
});

it("只看模式不显示长按预告，也不发点击和滚动", () => {
  const h = setup(false);
  act(() => {
    h.binding().callbacks.onCharge(100, 100);
    h.binding().callbacks.onScrollDelta(0, 80, 100, 100);
    h.binding().callbacks.onTap(100, 100, false);
  });
  expect(h.result.current.charging).toBe(false);
  expect(h.input.sendClick).not.toHaveBeenCalled();
  expect(h.input.scrollByFrame).not.toHaveBeenCalled();
});

it("辅助拖拽保持按住时，双指不能同时注入滚轮", () => {
  const h = setup();
  act(() => h.result.current.toggleDrag());
  act(() => h.binding().callbacks.onScrollDelta(0, 80, 100, 100));
  expect(h.input.scrollByFrame).not.toHaveBeenCalled();
  expect(h.result.current.dragging).toBe(true);
});
it("滚动态所有辅助点击入口均被同一守卫阻止", () => {
  const h = setup();
  act(() => h.result.current.toggleScroll());
  act(() => { h.result.current.click(1); h.result.current.click(2); });
  expect(h.input.sendClick).not.toHaveBeenCalled();
  act(() => h.result.current.toggleScroll());
  act(() => h.result.current.click(1));
  expect(h.input.sendClick).toHaveBeenCalledOnce();
});
it("收起辅助条后切换与恢复操作方式仍尊重开合选择", () => {
  const h = setup();
  act(() => h.result.current.toggleMouse());
  expect(h.result.current.mouseOpen).toBe(false);
  act(() => h.result.current.pickMode("direct"));
  expect(h.result.current.mouseOpen).toBe(false);
  act(() => h.result.current.pickMode("pad"));
  expect(h.result.current.mouseOpen).toBe(true);
  act(() => h.result.current.pickMode("trackpad"));
  expect(h.result.current.mouseOpen).toBe(false);
});
it("按钮锁住拖拽后长按移动再松手，仍保持拖拽直到再次点按钮", () => {
  const h = setup();
  act(() => h.result.current.toggleDrag());
  h.input.releaseAll.mockClear();
  act(() => {
    const b = h.binding();
    b.onDown(100, 100);
    b.callbacks.onCharge(100, 100);
    b.callbacks.onDragStart(130, 120);
    b.callbacks.onDragMove(140, 130);
    b.callbacks.onDragEnd(140, 130);
  });
  expect(h.result.current.dragging).toBe(true);
  expect(h.input.dragDown).toHaveBeenCalledTimes(1);
  expect(h.input.queueMove).toHaveBeenCalled();
  expect(h.input.releaseAll).not.toHaveBeenCalled();
  act(() => h.result.current.toggleDrag());
  expect(h.result.current.dragging).toBe(false);
  expect(h.input.releaseAll).toHaveBeenCalledOnce();
});
it("手势开始的拖拽在松手时释放", () => {
  const h = setup();
  act(() => h.binding().callbacks.onDragStart(100, 100));
  expect(h.result.current.dragging).toBe(true);
  act(() => h.binding().callbacks.onDragEnd(100, 100));
  expect(h.result.current.dragging).toBe(false);
  expect(h.input.releaseAll).toHaveBeenCalledOnce();
});
it("直接点击映射目标，模式切换和失焦释放拖拽及修饰键", () => {
  const h = setup();
  act(() => h.result.current.pickMode("direct"));
  act(() => h.binding().callbacks.onTap(120, 80, false));
  expect(h.input.sendClick.mock.calls[0][1]).toBeCloseTo(120, 0);
  act(() => h.result.current.toggleDrag());
  expect(h.result.current.dragging).toBe(true);
  act(() => window.dispatchEvent(new Event("blur")));
  expect(h.result.current.dragging).toBe(false);
  expect(h.releaseKeys).toHaveBeenCalled();
  expect(h.input.releaseAll).toHaveBeenCalled();
});

it("首次使用默认触控板，重进会话恢复选择，非法偏好回到默认", () => {
  const h = setup();
  expect(h.result.current.mode).toBe("trackpad");
  act(() => h.result.current.pickMode("pad"));
  h.unmount();
  const next = setup();
  expect(next.result.current.mode).toBe("pad");
  expect(next.result.current.padOpen).toBe(true);
  next.unmount();
  localStorage.setItem("pastepanda-mobile-pointer-mode", "invalid");
  expect(setup().result.current.mode).toBe("trackpad");
});

it.each(["pad", "floating"] as const)("%s 的画面仅调整本地视野，不注入点击、拖拽或滚轮", (mode) => {
  const h = setup();
  act(() => h.result.current.pickMode(mode));
  act(() => {
    const b = h.binding();
    b.onDown(100, 100);
    b.callbacks.onMoveTo(130, 120);
    b.callbacks.onTap(130, 120, false);
    b.callbacks.onCharge(130, 120);
    b.callbacks.onRightClick(130, 120);
    b.callbacks.onDragStart(130, 120);
    b.callbacks.onScrollDelta(10, 20, 130, 120);
  });
  expect(h.viewport.applyPinch).toHaveBeenCalledWith(1, 30, 20, 130, 120);
  expect(h.input.queueMove).not.toHaveBeenCalled();
  expect(h.input.sendClick).not.toHaveBeenCalled();
  expect(h.input.dragDown).not.toHaveBeenCalled();
  expect(h.input.scrollByFrame).not.toHaveBeenCalled();
});

it("独立触控板仍以相对位移控制电脑，切换方式清除拖拽及修饰键", () => {
  const h = setup();
  act(() => h.result.current.pickMode("pad"));
  act(() => {
    h.pad().onDown(100, 100);
    h.pad().callbacks.onMoveTo(130, 120);
    h.pad().callbacks.onTap(130, 120, false);
  });
  expect(h.input.sendClick.mock.calls[0][1]).toBeCloseTo(530, 0);
  act(() => h.result.current.toggleDrag());
  h.input.releaseAll.mockClear();
  h.releaseKeys.mockClear();
  act(() => h.binding().callbacks.onDragEnd(100, 100));
  expect(h.result.current.dragging).toBe(true);
  expect(h.input.releaseAll).not.toHaveBeenCalled();
  act(() => h.result.current.pickMode("floating"));
  expect(h.result.current.dragging).toBe(false);
  expect(h.input.releaseAll).toHaveBeenCalled();
  expect(h.releaseKeys).toHaveBeenCalled();
});

it("浮动鼠标沿用内容坐标，按住拖拽移动，滚动时不移动指针", () => {
  const h = setup();
  act(() => h.result.current.pickMode("floating"));
  act(() => h.result.current.moveFloating(30, 20));
  expect(h.input.queueMove.mock.calls[0][0]).toBeCloseTo(530, 0);
  act(() => h.result.current.toggleDrag());
  act(() => h.result.current.moveFloating(10, 0));
  expect(h.feedback.charge).toHaveBeenLastCalledWith("drag", expect.closeTo(540, 0), expect.closeTo(270, 0));
  act(() => h.result.current.toggleScroll());
  h.input.queueMove.mockClear();
  act(() => h.result.current.moveFloating(0, -80));
  expect(h.input.scrollByFrame).toHaveBeenCalledWith(0, -80, expect.any(Number), expect.any(Number));
  expect(h.input.queueMove).not.toHaveBeenCalled();
});

it("只看时浮动控制和辅助滚动均不能注入，偏好存储失败仍能切换并提示", () => {
  const h = setup(false);
  act(() => h.result.current.pickMode("floating"));
  act(() => { h.result.current.moveFloating(30, 20); h.result.current.toggleScroll(); });
  expect(h.input.queueMove).not.toHaveBeenCalled();
  expect(h.result.current.scrolling).toBe(false);
  const store = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  act(() => h.result.current.pickMode("direct"));
  expect(h.result.current.mode).toBe("direct");
  expect(h.result.current.hint).toContain("无法保存");
  store.mockRestore();
});
