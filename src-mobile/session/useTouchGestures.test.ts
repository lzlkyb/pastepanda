import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTouchGestures } from "./useTouchGestures";
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup() {
  const el = document.createElement("div"); el.setPointerCapture = vi.fn();
  const callbacks = { onTap: vi.fn(), onMoveTo: vi.fn(), onCharge: vi.fn(), onChargeCancel: vi.fn(), onRightClick: vi.fn(), onDragStart: vi.fn(), onDragMove: vi.fn(), onDragEnd: vi.fn(), onScrollDelta: vi.fn(), onPinchStart: vi.fn(), onPinchUpdate: vi.fn() };
  const cancel = vi.fn();
  renderHook(() => useTouchGestures({ surfaceRef: { current: el }, enabled: true, callbacks, onCancel: cancel }));
  const emit = (name: string) => act(() => { el.dispatchEvent(Object.assign(new Event(name), { pointerId: 1, clientX: 100, clientY: 100, button: 0, pointerType: "touch" })); });
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
