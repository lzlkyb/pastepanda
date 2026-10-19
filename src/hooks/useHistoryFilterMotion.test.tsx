import { useRef } from "react";
import type Lenis from "lenis";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setMotionPreference } from "@/lib/motionPreference";
import { useHistoryFilterMotion } from "./useHistoryFilterMotion";
const { mode } = vi.hoisted(() => ({ mode: { value: "full" } }));
vi.mock("@/components/MotionPolicy", () => ({ useInterfaceMotion: () => mode.value }));
const cancel = vi.fn(), animate = vi.fn(() => ({ cancel, finished: new Promise(() => {}) }));
const scrollTo = vi.fn();
function List({ filterKey = "all", ready = true }) {
  const lenisRef = useRef({ scrollTo } as unknown as Lenis);
  const ref = useHistoryFilterMotion({ filterKey, ready, lenisRef });
  return <div ref={ref}>示例结果</div>;
}
beforeEach(() => { mode.value = "full"; setMotionPreference(true); vi.spyOn(document, "hidden", "get").mockReturnValue(false); vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList); Element.prototype.animate = animate as unknown as typeof Element.prototype.animate; });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); setMotionPreference(true); });
it("新结果用 6px 轻移淡入；首次加载及重复渲染不播放", () => {
  const { rerender } = render(<List />); expect(animate).not.toHaveBeenCalled();
  rerender(<List filterKey="text" />);
  expect(animate).toHaveBeenCalledWith([{ opacity: .35, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], expect.objectContaining({ duration: 200 }));
  rerender(<List filterKey="text" />); expect(animate).toHaveBeenCalledTimes(1);
});
it("先复位滚动，等新结果可用再播放，连点只保留最后一次", () => {
  const { rerender } = render(<List />);
  rerender(<List filterKey="text" ready={false} />);
  expect(scrollTo).toHaveBeenCalledWith(0, { immediate: true });
  expect(animate).not.toHaveBeenCalled();
  rerender(<List filterKey="image" ready={false} />);
  rerender(<List filterKey="image" ready />); expect(animate).toHaveBeenCalledTimes(1);
  rerender(<List filterKey="file" />); expect(cancel).toHaveBeenCalledTimes(1);
  expect(animate).toHaveBeenCalledTimes(2);
});
it.each(["reduced", "off", "hidden"])("%s 模式立即切换，不播放或在恢复可见时补播", value => {
  const { rerender } = render(<List />); mode.value = value;
  rerender(<List filterKey="image" />); expect(animate).not.toHaveBeenCalled();
  expect(scrollTo).toHaveBeenCalled(); mode.value = "full";
  rerender(<List filterKey="image" />); expect(animate).not.toHaveBeenCalled();
});
it("卸载取消尚未结束的切换", () => {
  const { rerender, unmount } = render(<List />); rerender(<List filterKey="file" />);
  unmount(); expect(cancel).toHaveBeenCalledOnce();
});
