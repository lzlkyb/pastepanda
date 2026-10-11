import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeImageViewer } from "./KnowledgeImageViewer";
import { setupMotionClock } from "../ui/mobileMotionTestUtils";
import { readFile } from "node:fs/promises";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("图片按钮拥有缩放与适应的等价入口，失败有恢复动作", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const clock = setupMotionClock(); clock.reduced.matches = true;
  const view = render(<KnowledgeImageViewer active image={{src:"/note.png",alt:"笔记插图"}} onClose={() => {}} />);
  const image = screen.getByAltText("笔记插图"), wrapper = image.parentElement!, surface = wrapper.parentElement!;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 }) as DOMRect;
  fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
  expect(wrapper.style.transform).toContain("scale(1.5)");
  fireEvent.click(screen.getByRole("button", { name: "适应" }));
  expect(wrapper.style.transform).toContain("scale(1)");
  fireEvent.error(image);
  expect(screen.getByRole("alert").textContent).toContain("图片未能打开");
  expect(screen.getByRole("button", { name: "放大图片" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => view.unmount());
});

it("竖屏图片弹层有确定高度，flex视野不能在auto高度父级中坍缩", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const clock = setupMotionClock(); clock.reduced.matches = true;
  render(<KnowledgeImageViewer active image={{src:"/note.png",alt:"插图"}} onClose={() => {}} />);
  expect(screen.getByRole("dialog").className).toContain("imageSheet");
  const css = await readFile("src-mobile/knowledge/KnowledgeImageCanvas.module.css", "utf8");
  expect(css).toMatch(/\.imageSheet\[role="dialog"\]\s*\{\s*height:\s*calc\(var\(--mobile-viewport-height,\s*100dvh\)\s*\*\s*0\.8\)/);
});

it("放大图片按住后再拖动，仍然移动图片而不是陷入远控长按语义", () => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const clock = setupMotionClock(); clock.reduced.matches = true;
  render(<KnowledgeImageViewer active image={{src:"/note.png",alt:"笔记插图"}} onClose={() => {}} />);
  const image = screen.getByAltText("笔记插图"), wrapper = image.parentElement!, surface = wrapper.parentElement!;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 }) as DOMRect;
  surface.setPointerCapture = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
  const before = wrapper.style.transform;
  const emit = (name: string, x: number) => act(() => surface.dispatchEvent(Object.assign(new Event(name), {pointerId:1,clientX:x,clientY:100,pointerType:"touch",button:0})));
  emit("pointerdown",100);
  act(() => vi.advanceTimersByTime(600));
  emit("pointermove",130); emit("pointermove",150);
  expect(wrapper.style.transform).not.toBe(before);
  emit("pointerup",150);
});
