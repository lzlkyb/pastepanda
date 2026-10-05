import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRcNearbyPair } from "./useRcNearbyPair";

const status = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/rcPair", () => ({ rcNearbyStatus: status, rcNearbyPair: vi.fn(), rcNearbyConfirm: vi.fn(), rcNearbyCancel: vi.fn() }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
beforeEach(() => { status.mockReset(); status.mockResolvedValue({ neighbors: [], pair: null, done: null }); });

describe("附近设备按需刷新", () => {
  it("未打开时不请求，关闭后清除列表定时器", async () => {
    vi.useFakeTimers();
    try {
      const view = renderHook(({ enabled }) => useRcNearbyPair({ enabled }), { initialProps: { enabled: false } });
      expect(status).not.toHaveBeenCalled();
      await act(async () => view.rerender({ enabled: true }));
      expect(status).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(status).toHaveBeenCalledTimes(2);
      view.rerender({ enabled: false });
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(status).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("首页来访观察者不消费主动配对的完成通知", async () => {
    const done = { peer_id: "peer", peer_name: "电脑", initiator: true, at_ms: Date.now() + 1000 };
    status.mockResolvedValue({ neighbors: [], pair: null, done });
    const observer = renderHook(() => useRcNearbyPair({ incomingOnly: true }));
    await waitFor(() => expect(observer.result.current.loading).toBe(false));
    expect(observer.result.current.done).toBeNull();
    const dialog = renderHook(() => useRcNearbyPair());
    await waitFor(() => expect(dialog.result.current.done).toEqual(done));
  });
  it("读取失败保留可见错误，重试成功清除错误", async () => {
    status.mockRejectedValueOnce(new Error("offline"));
    const view = renderHook(() => useRcNearbyPair());
    await waitFor(() => expect(view.result.current.error).toContain("offline"));
    await act(async () => view.result.current.refresh());
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.loading).toBe(false);
  });
});
