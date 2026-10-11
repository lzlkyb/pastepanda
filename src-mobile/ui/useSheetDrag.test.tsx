import { act, cleanup, render, renderHook } from "@testing-library/react";
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
      clientY: sideways ? 100 : y,
      clientX: sideways ? y : 100,
      pointerId: id,
      timeStamp: time,
      button: 0,
      currentTarget: { setPointerCapture: vi.fn() },
    }) as unknown as PointerEvent<HTMLButtonElement>;
  return { ...h, close, sheet, event, clock };
}
it.each([false, true])("主轴未占优的斜滑不移动或关闭弹层（横屏 %s）", sideways => {
  const h = setup(sideways);
  const event = (main: number, cross: number, time: number) => ({ ...h.event(main, 1, time),
    clientX: sideways ? main : cross, clientY: sideways ? cross : main });
  act(() => {
    h.result.current.onPointerDown(event(100, 100, 0));
    h.result.current.onPointerMove(event(140, 200, 20));
  });
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
  act(() => h.result.current.onPointerUp(event(140, 200, 25)));
  expect(h.close).not.toHaveBeenCalled();
});

it("最后一帧的速度尖峰不把慢速短拖误判为甩动关闭", () => {
  const h = setup();
  const event = (main: number, time: number) => ({ ...h.event(main, 1, time), clientX: 100 });
  act(() => {
    h.result.current.onPointerDown(event(100, 100));
    h.result.current.onPointerMove(event(120, 200));
    h.result.current.onPointerMove(event(121, 229));
    h.result.current.onPointerMove(event(127, 230));
    h.result.current.onPointerUp(event(127, 235));
  });
  expect(h.close).not.toHaveBeenCalled();
  act(() => h.clock.advance(1200));
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
});
it("起手方向模糊时等待，后续明确主轴仍能继续跟手", () => {
  const h = setup();
  act(() => {
    h.result.current.onPointerDown(h.event(100, 1, 0));
    h.result.current.onPointerMove({ ...h.event(110, 1, 20), clientX: 109 });
  });
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
  act(() => h.result.current.onPointerMove({ ...h.event(130, 1, 50), clientX: 110 }));
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("30px");
  act(() => h.result.current.onPointerCancel());
});
it("始终模糊的斜滑松手也不被速度判断误关", () => {
  const h = setup();
  act(() => {
    h.result.current.onPointerDown(h.event(100, 1, 0));
    h.result.current.onPointerMove({ ...h.event(140, 1, 20), clientX: 136 });
    h.result.current.onPointerUp({ ...h.event(140, 1, 25), clientX: 136 });
  });
  expect(h.close).not.toHaveBeenCalled();
});

it.each([false, true])("返回来源步骤后面板保持打开并回到可见位置（横屏 %s）", sideways => {
  const clock = setupMotionClock();
  const h = renderHook(() => {
    const [step, setStep] = useState("screen");
    return { step, ...useSheetDrag(true, () => setStep("more"), sideways) };
  });
  const sheet = document.createElement("div");
  Object.defineProperties(sheet, { offsetHeight: { value: 400 }, offsetWidth: { value: 400 } });
  h.result.current.sheetRef.current = sheet;
  const event = (position: number, time: number) => ({ clientX: sideways ? position : 0, clientY: sideways ? 0 : position, button: 0,
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
    h.result.current.onPointerMove({ ...h.event(190), clientX: 100, clientY: 190 });
    h.result.current.onPointerUp({ ...h.event(190), clientX: 100, clientY: 190 });
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

it("页头轻点不收起，关闭按钮不被拖动捕获", () => {
  const h = setup();
  const header = document.createElement("header");
  header.setPointerCapture = vi.fn();
  const title = document.createElement("h2"); header.append(title);
  act(() => {
    h.result.current.onPointerDown({ ...h.event(0), currentTarget: header, target: title });
    h.result.current.onPointerUp({ ...h.event(0), currentTarget: header, target: title });
  });
  expect(h.close).not.toHaveBeenCalled();
  const button = document.createElement("button"); header.append(button);
  act(() => h.result.current.onPointerDown({ ...h.event(0), currentTarget: header, target: button }));
  expect(header.setPointerCapture).toHaveBeenCalledTimes(1);
});

it("原生返回开始取消正在拖动的面板，不执行关闭", () => {
  const h = setup();
  act(() => {
    h.result.current.onPointerDown(h.event(100));
    h.result.current.onPointerMove(h.event(150));
    window.dispatchEvent(new Event("mobile-interaction-cancel"));
  });
  act(() => h.clock.advance(1200));
  expect(h.sheet.style.getPropertyValue("--mobile-sheet-offset")).toBe("0px");
  expect(h.close).not.toHaveBeenCalled();
});

it("遮罩按面板位移跟手变淡，取消后回到完整遮罩", () => {
  const clock = setupMotionClock(), close = vi.fn();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
  function Fixture() {
    const { sheetRef, overlayRef, onPointerDown, onPointerMove, onPointerCancel } = useSheetDrag(true, close);
    return <><div ref={overlayRef} data-testid="scrim" /><div ref={sheetRef} data-testid="panel"><button onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerCancel={onPointerCancel}>把手</button></div></>;
  }
  const h = render(<Fixture />), handle = h.getByText("把手");
  act(() => clock.advance(1200));
  const pointer = (y: number) => ({ button: 0, pointerId: 1, clientX: 100, clientY: y });
  // jsdom has no native PointerEvent; the DOM event still exposes its actual coordinates.
  const send = (name: string, y: number) => { const event = new Event(name, { bubbles: true }); Object.assign(event, pointer(y)); act(() => handle.dispatchEvent(event)); };
  send("pointerdown", 100); send("pointermove", 200);
  expect(h.getByTestId("panel").style.getPropertyValue("--mobile-sheet-offset")).toBe("100px");
  expect(h.getByTestId("scrim").style.getPropertyValue("--mobile-sheet-scrim")).toBe("0.75");
  send("pointercancel", 200); act(() => clock.advance(1200));
  expect(h.getByTestId("scrim").style.getPropertyValue("--mobile-sheet-scrim")).toBe("1");
  expect(close).not.toHaveBeenCalled(); expect(clock.frames.size).toBe(0);
});
