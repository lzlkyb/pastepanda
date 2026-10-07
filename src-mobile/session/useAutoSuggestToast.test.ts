import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoSuggestToast } from "./useAutoSuggestToast";
import type { MobileConnectionInfo } from "./useMobileConnectionInfo";

const accept = vi.fn();
const good: MobileConnectionInfo = { sessionId: "a", state: "connected", label: "流畅", grade: "ok", rttMs: 25, path: "公网直连", pathKind: "direct", frames: null, lossPermille: 0, samples: [], sampledAt: Date.now() };
beforeEach(() => { vi.useFakeTimers(); accept.mockClear(); });
afterEach(() => vi.useRealTimers());

it("实名档锁定且链路持续顺畅 15 秒，提示一次切回自动", () => {
  const { result, rerender } = renderHook(({ locked }) => useAutoSuggestToast(good, locked, accept), { initialProps: { locked: "sharp" } });
  act(() => vi.advanceTimersByTime(10000));
  rerender({ locked: "sharp" });
  act(() => vi.advanceTimersByTime(6000));
  expect(result.current?.title).toBe("链路已持续顺畅");
  act(() => result.current!.accept());
  expect(result.current).toBeNull();
  expect(accept).toHaveBeenCalledOnce();
});
it("锁 auto 或未确认画质时不提示；中继链路不提示", () => {
  const { result, rerender } = renderHook(({ info, locked }) => useAutoSuggestToast(info, locked, accept), { initialProps: { info: good, locked: null as string | null } });
  act(() => vi.advanceTimersByTime(20000));
  rerender({ info: good, locked: "auto" });
  act(() => vi.advanceTimersByTime(20000));
  expect(result.current).toBeNull();
  rerender({ info: good, locked: "sharp" });
  act(() => vi.advanceTimersByTime(20000));
  expect(result.current).not.toBeNull();
  act(() => result.current!.dismiss());
  rerender({ info: { ...good, pathKind: "relay" }, locked: "sharp" });
  act(() => vi.advanceTimersByTime(20000));
  expect(result.current).toBeNull();
});
it("链路中途变差重新计时；关掉后同档不再纠缠，换会话恢复资格", () => {
  const { result, rerender } = renderHook(({ info, locked }) => useAutoSuggestToast(info, locked, accept), { initialProps: { info: good, locked: "sharp" } });
  act(() => vi.advanceTimersByTime(10000));
  rerender({ info: { ...good, grade: "poor" as const, label: "偏慢", rttMs: 300 }, locked: "sharp" });
  act(() => vi.advanceTimersByTime(10000));
  rerender({ info: good, locked: "sharp" });
  act(() => vi.advanceTimersByTime(6000));
  expect(result.current).toBeNull();
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current?.title).toBe("链路已持续顺畅");
  act(() => result.current!.dismiss());
  act(() => vi.advanceTimersByTime(30000));
  rerender({ info: good, locked: "sharp" });
  expect(result.current).toBeNull();
  rerender({ info: { ...good, sessionId: "b" }, locked: "sharp" });
  act(() => vi.advanceTimersByTime(16000));
  expect(result.current?.title).toBe("链路已持续顺畅");
});
