import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAPSULE_TEACH_STORAGE_KEY, CAPSULE_TEACH_SECONDS, useImmersiveCapsule } from "./useImmersiveCapsule";
const layout = vi.hoisted(() => ({ landscape: false }));
vi.mock("../ui/useMobileLayout", () => ({ useMobileLayout: () => layout.landscape }));
beforeEach(() => { layout.landscape = false; localStorage.removeItem(CAPSULE_TEACH_STORAGE_KEY); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("首次横屏短时展开，提示自动结束，不留无限脉冲", () => {
  const h = renderHook(() => useImmersiveCapsule({ keyboardOpen: false }));
  act(() => { layout.landscape = true; h.rerender(); });
  expect(h.result.current.phase).toBe("teaching");
  expect(h.result.current.capsuleVisible).toBe(true);
  act(() => { vi.advanceTimersByTime(CAPSULE_TEACH_SECONDS * 1000); });
  expect(h.result.current.phase).toBe("hint");
  expect(h.result.current.capsuleVisible).toBe(false);
  act(() => { vi.advanceTimersByTime(4000); });
  expect(h.result.current.phase).toBe("done");
});
it("新会话不重复教学，仍可点击工具打开", () => {
  layout.landscape = true;
  const first = renderHook(() => useImmersiveCapsule({ keyboardOpen: false })); first.unmount();
  const next = renderHook(() => useImmersiveCapsule({ keyboardOpen: false }));
  expect(next.result.current.phase).toBe("done");
  expect(next.result.current.capsuleVisible).toBe(false);
  act(() => next.result.current.toggle()); expect(next.result.current.capsuleVisible).toBe(true);
});
it("用户主动操作后，旧教学计时器不再收起工具", () => {
  layout.landscape = true;
  const h = renderHook(() => useImmersiveCapsule({ keyboardOpen: false }));
  act(() => h.result.current.toggle()); act(() => h.result.current.toggle());
  act(() => vi.advanceTimersByTime(30000));
  expect(h.result.current.phase).toBe("done"); expect(h.result.current.capsuleVisible).toBe(true);
});
it("键盘或面板展开强制可见，切回竖屏结束引导", () => {
  const h = renderHook(({ open }) => useImmersiveCapsule({ keyboardOpen: open }), { initialProps: { open: true } });
  expect(h.result.current.capsuleVisible).toBe(true);
  act(() => { layout.landscape = true; h.rerender({ open: false }); });
  act(() => { layout.landscape = false; h.rerender({ open: false }); });
  expect(h.result.current.phase).toBe("done"); expect(h.result.current.capsuleVisible).toBe(false);
});
