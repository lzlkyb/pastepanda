import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useOrientationLock } from "./useOrientationLock";
const state = vi.hoisted(() => ({ native: true, landscape: false, display: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => state.native }));
vi.mock("@/lib/api/rcCommands", () => ({ rcSessionDisplay: state.display }));
vi.mock("../ui/useMobileLayout", () => ({ useMobileLayout: () => state.landscape }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); state.display.mockReset(); state.native = true; state.landscape = false; vi.unstubAllGlobals(); });
it("随系统旋转应用原生沉浸，退出只释放自己的会话", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  state.display.mockResolvedValue(undefined);
  const { rerender, unmount } = renderHook(() => useOrientationLock("s"));
  await act(async () => {});
  expect(state.display).toHaveBeenLastCalledWith("s", true, false, "system");
  state.landscape = true; rerender();
  await act(async () => {});
  expect(state.display).toHaveBeenLastCalledWith("s", true, true, "system");
  unmount(); expect(state.display).toHaveBeenLastCalledWith("s", false, false);
});
it("竖屏按钮确实请求 portrait，不只是解锁", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  state.display.mockResolvedValue(undefined);
  const { result } = renderHook(() => useOrientationLock("s"));
  await act(async () => { await result.current.exitLandscape(); });
  expect(state.display).toHaveBeenLastCalledWith("s", true, false, "portrait");
});
it("浏览器全屏成功但方向锁失败，卸载仍释放全屏", async () => {
  state.native = false;
  const full = vi.fn().mockResolvedValue(undefined), exit = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: full });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  vi.stubGlobal("screen", { orientation: { lock: vi.fn().mockRejectedValue(new Error("denied")), unlock: vi.fn() } });
  const { result, unmount } = renderHook(() => useOrientationLock());
  await act(async () => { await result.current.enterLandscape(); });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
  unmount(); expect(exit).toHaveBeenCalledOnce();
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
});
