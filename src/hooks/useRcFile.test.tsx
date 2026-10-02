import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRcFile } from "./useRcFile";
import { useRcFileStore } from "@/stores/rcFileStore";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/api/rcFile", () => ({
  rcFileSnapshot: vi.fn(async () => ({ asks: [], tasks: [] })),
  rcFileCancel: vi.fn(), rcFileClearFinished: vi.fn(), rcFilePull: vi.fn(),
  rcFileRespond: vi.fn(), rcFileSend: vi.fn(),
}));

beforeEach(() => {
  useRcFileStore.setState({ snapshot: { asks: [], tasks: [] }, error: null, errorPeer: null, busy: false });
});
afterEach(cleanup);

describe("设备文件错误归属", () => {
  it("切到 B 后 A 的迟到错误只在 A 显示，全局视图仍可见", () => {
    const device = renderHook(({ peer }) => useRcFile(peer), { initialProps: { peer: "a" } });
    const global = renderHook(() => useRcFile());
    device.rerender({ peer: "b" });
    act(() => useRcFileStore.setState({ error: "A 的发送失败", errorPeer: "a" }));
    expect(device.result.current.error).toBeNull();
    expect(global.result.current.error).toBe("A 的发送失败");
    device.rerender({ peer: "a" });
    expect(device.result.current.error).toBe("A 的发送失败");
  });

  it("全局快照错误仍显示在设备页，清空动作绑定当前设备", async () => {
    const { result } = renderHook(() => useRcFile("b"));
    act(() => useRcFileStore.setState({ error: "读取传输状态失败", errorPeer: null }));
    expect(result.current.error).toBe("读取传输状态失败");
    const api = await import("@/lib/api/rcFile");
    await act(() => result.current.clearFinished());
    expect(api.rcFileClearFinished).toHaveBeenCalledWith("b");
  });
});
