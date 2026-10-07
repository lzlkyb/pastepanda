import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDirectSwitchToast } from "./useDirectSwitchToast";
import type { MobileConnectionInfo } from "./useMobileConnectionInfo";

const base: MobileConnectionInfo = { sessionId: "a", state: "connected", label: "流畅", grade: "ok", rttMs: 30, path: "", pathKind: "", frames: null, lossPermille: 0, samples: [], sampledAt: Date.now() };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("中继停留足够久后切回直连，弹一次播报", () => {
  const { result, rerender } = renderHook(({ info }) => useDirectSwitchToast(info), { initialProps: { info: { ...base, pathKind: "relay" } } });
  act(() => vi.advanceTimersByTime(6000));
  rerender({ info: { ...base, pathKind: "relay" } });
  act(() => vi.advanceTimersByTime(1000));
  rerender({ info: { ...base, pathKind: "direct", rttMs: 22 } });
  expect(result.current?.title).toBe("已切回直连");
  act(() => result.current!.dismiss());
  expect(result.current).toBeNull();
});
it("只在直连态播报，短暂中继闪变不弹", () => {
  const { result, rerender } = renderHook(({ info }) => useDirectSwitchToast(info), { initialProps: { info: { ...base, pathKind: "relay" } } });
  act(() => vi.advanceTimersByTime(1000));
  rerender({ info: base });
  expect(result.current).toBeNull();
  rerender({ info: { ...base, pathKind: "direct" } });
  expect(result.current).toBeNull();
});
it("未连接（重连中/等待画面）不播报，换会话不计旧停留", () => {
  const { result, rerender } = renderHook(({ info }) => useDirectSwitchToast(info), { initialProps: { info: { ...base, pathKind: "relay" } } });
  act(() => vi.advanceTimersByTime(7000));
  rerender({ info: { ...base, pathKind: "direct", state: "connecting", rttMs: 0, label: "测量中", grade: "unknown" } });
  expect(result.current).toBeNull();
  rerender({ info: { ...base, sessionId: "b", pathKind: "relay" } });
  act(() => vi.advanceTimersByTime(2000));
  rerender({ info: { ...base, sessionId: "b", pathKind: "direct" } });
  expect(result.current).toBeNull();
  rerender({ info: { ...base, sessionId: "b", pathKind: "relay" } });
  act(() => vi.advanceTimersByTime(7000));
  rerender({ info: { ...base, sessionId: "b", pathKind: "direct" } });
  expect(result.current?.title).toBe("已切回直连");
});
