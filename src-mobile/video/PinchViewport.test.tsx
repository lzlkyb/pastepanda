import { cleanup, render, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { PinchViewport, type PinchViewportHandle } from "./PinchViewport";
import { clampRcViewportOffset } from "@/lib/utils";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("缩放与平移留在可达视野，缩小时居中", () => {
  expect(clampRcViewportOffset(500, 300, 2)).toBe(0);
  expect(clampRcViewportOffset(-800, 300, 2)).toBe(-300);
  expect(clampRcViewportOffset(500, 300, 0.5)).toBe(75);
});
it("键盘或旋转改变视野后重新约束，适应屏幕恢复原点", () => {
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() {} });
  const ref = createRef<PinchViewportHandle>(), surfaceRef = createRef<HTMLElement>();
  const h = render(<PinchViewport ref={ref} surfaceRef={surfaceRef}><span>画面</span></PinchViewport>);
  let width = 300;
  surfaceRef.current!.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 200 }) as DOMRect;
  act(() => ref.current!.applyPinch(2, -1000, -1000, 0, 0));
  const wrapper = h.container.querySelector("span")!.parentElement!;
  expect(wrapper.style.transform).toBe("translate(-300px, -200px) scale(2)");
  width = 150; act(() => resize());
  expect(wrapper.style.transform).toBe("translate(-150px, -200px) scale(2)");
  act(() => ref.current!.reset());
  expect(wrapper.style.transform).toBe("translate(0px, 0px) scale(1)");
});

it("宽图放大后不能被拖出视野，图框边界不包含object-fit留白", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const viewport = createRef<PinchViewportHandle>(), surface = createRef<HTMLElement>();
  const content = {current:{w:1200,h:120}};
  const view = render(<PinchViewport ref={viewport} surfaceRef={surface} contentSize={content}><span>宽图</span></PinchViewport>);
  surface.current!.getBoundingClientRect = () => ({left:0,top:0,width:300,height:200}) as DOMRect;
  act(() => viewport.current!.applyPinch(4,0,-10000,150,100));
  expect(view.container.querySelector("span")!.parentElement!.style.transform).toBe("translate(-450px, -300px) scale(4)");
});
