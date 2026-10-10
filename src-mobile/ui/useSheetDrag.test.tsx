import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PointerEvent } from "react";
import { useState } from "react";
import { useSheetDrag } from "./useSheetDrag";
import { setupMotionClock } from "./mobileMotionTestUtils";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(sideways = false) {
  const clock = setupMotionClock();
  const close = vi.fn();
  const h = renderHook(({ open }) => useSheetDrag(open, close, sideways), { initialProps: { open: true } });
  const sheet = document.createElement("div");
  h.result.current.sheetRef.current = sheet;
  const event = (y: number, id = 1, time = 0) =>
    ({
      clientY: y,
      clientX: y,
      pointerId: id,
      timeStamp: time,
      button: 0,
      currentTarget: { setPointerCapture: vi.fn() },
    }) as unknown as PointerEvent<HTMLButtonElement>;
  return { ...h, close, sheet, event, clock };
}
it.each([false, true])("返回来源步骤后面板保持打开并回到可见位置（横屏 %s）", sideways => {
  const clock = setupMotionClock();
  const h = renderHook(() => {
    const [step, setStep] = useState("screen");
    return { step, ...useSheetDrag(true, () => setStep("more"), sideways) };
  });
  const sheet = document.createElement("div");
  Object.defineProperties(sheet, { offsetHeight: { value: 400 }, offsetWidth: { value: 400 } });
  h.result.current.sheetRef.current = sheet;
  const event = (position: number, time: number) => ({ clientX: position, clientY: position, button: 0,
    pointerId: 1, timeStamp: time, currentTarget: { setPointerCapture() {} } }) as unknown as PointerEvent<HTMLButtonElement>;
  act(() => {
    h.result.current.onPointerDown(event(0, 0));
    h.result.current.onPointerMove(event(220, 100));
    h.result.current.onPointerUp(event(220, 110));
  });
  act(() => clock.advance(1200));
  expect(h.result.current.step).toBe("more");
  expect(h.result.current.present).toBe(true);
  expect(sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
});
it("横屏沿右侧进出，垂直滑动把手不能误判为点击收起", () => {
  const h = setup(true);
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onPointerMove({ ...h.event(190), clientX: 100 });
    h.result.current.onPointerUp({ ...h.event(190), clientX: 100 });
  });
  expect(h.close).not.toHaveBeenCalled();
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onPointerMove({ ...h.event(190), clientY: 100 });
    h.result.current.onPointerUp({ ...h.event(190), clientY: 100 });
  });
  expect(h.close).toHaveBeenCalledTimes(1);
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("90px");
});
it("面板跟随把手，短拖动回位且不关闭", () => {
  const h = setup();
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onPointerMove(h.event(140));
  });
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("40px");
  act(() => h.result.current.onPointerUp(h.event(140)));
  act(() => h.clock.advance(1200));
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
  expect(h.close).not.toHaveBeenCalled();
});
it("拖足距离关闭；系统取消和捕获丢失只回位", () => {
  const h = setup();
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onPointerUp(h.event(190));
  });
  expect(h.close).toHaveBeenCalledTimes(1);
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onPointerMove(h.event(180));
    h.result.current.onPointerCancel();
  });
  expect(h.close).toHaveBeenCalledTimes(1);
  expect(h.sheet.hasAttribute("data-dragging")).toBe(false);
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onLostPointerCapture();
  });
  act(() => h.clock.advance(1200));
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
});
it("另一指不能接管面板拖动，关闭后清除位移", () => {
  const h = setup();
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onPointerDown(h.event(200, 2));
    h.result.current.onPointerMove(h.event(250, 2));
  });
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
  h.rerender({ open: false });
  expect(h.sheet.hasAttribute("data-dragging")).toBe(false);
});
it("短距离快速下甩关闭，停留后松手只回弹", () => {
  const h = setup();
  act(() => {
    h.result.current.onPointerDown(h.event(100, 1, 0));
    h.result.current.onPointerMove(h.event(130, 1, 20));
    h.result.current.onPointerUp(h.event(130, 1, 25));
  });
  expect(h.close).toHaveBeenCalledTimes(1);
  act(() => {
    h.result.current.onPointerDown(h.event(100, 1, 100));
    h.result.current.onPointerMove(h.event(120, 1, 120));
    h.result.current.onPointerUp(h.event(120, 1, 250));
  });
  expect(h.close).toHaveBeenCalledTimes(1);
});
