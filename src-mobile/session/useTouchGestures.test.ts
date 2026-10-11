import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTouchGestures } from "./useTouchGestures";
afterEach(() => { cleanup(); vi.useRealTimers(); delete document.body.dataset.mobileBack; });
function setup(longPress = true) {
  const el = document.createElement("div"); el.setPointerCapture = vi.fn();
  const callbacks = { onTap: vi.fn(), onMoveTo: vi.fn(), onCharge: vi.fn(), onChargeCancel: vi.fn(), onRightClick: vi.fn(), onDragStart: vi.fn(), onDragMove: vi.fn(), onDragEnd: vi.fn(), onScrollDelta: vi.fn(), onPinchStart: vi.fn(), onPinchUpdate: vi.fn() };
  const cancel = vi.fn();
  renderHook(() => useTouchGestures({ surfaceRef: { current: el }, enabled: true, callbacks, onCancel: cancel, longPress }));
  const emit = (name: string, x = 100, id = 1) => act(() => { el.dispatchEvent(Object.assign(new Event(name), { pointerId: id, clientX: x, clientY: 100, button: 0, pointerType: "touch" })); });
  return { callbacks, cancel, emit };
}
it("正常抬指后的捕获释放不取消已经完成的点击", () => {
  const h = setup(); h.emit("pointerdown"); h.emit("pointerup"); h.emit("lostpointercapture");
  expect(h.callbacks.onTap).toHaveBeenCalledOnce();
  expect(h.cancel).not.toHaveBeenCalled();
});
it("按住期间丢失捕获取消充能及远端输入", () => {
  vi.useFakeTimers(); const h = setup(); h.emit("pointerdown");
  act(() => vi.advanceTimersByTime(550));
  h.emit("lostpointercapture"); h.emit("pointerup");
  expect(h.callbacks.onChargeCancel).toHaveBeenCalledOnce();
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.callbacks.onRightClick).not.toHaveBeenCalled();
});

it("原生返回取消触摸，预览期间不生成新的远端点击", () => {
  const h = setup(); h.emit("pointerdown");
  act(() => { document.body.dataset.mobileBack = "true"; window.dispatchEvent(new Event("mobile-interaction-cancel")); });
  h.emit("pointerup"); h.emit("pointerdown"); h.emit("pointerup");
  expect(h.callbacks.onTap).not.toHaveBeenCalled();
  delete document.body.dataset.mobileBack;
  h.emit("pointerdown"); h.emit("pointerup");
  expect(h.callbacks.onTap).toHaveBeenCalledOnce();
});

it("图片手势不进入远控长按拖拽，按住移动后仍可加入第二指缩放", () => {
  vi.useFakeTimers(); const h = setup(false);
  h.emit("pointerdown",100); act(() => vi.advanceTimersByTime(600));
  h.emit("pointermove",130); h.emit("pointerdown",180,2);
  h.emit("pointermove",110); h.emit("pointermove",200,2);
  expect(h.callbacks.onPinchStart).toHaveBeenCalledOnce();
  expect(h.callbacks.onCharge).not.toHaveBeenCalled();
  expect(h.callbacks.onDragStart).not.toHaveBeenCalled();
});
