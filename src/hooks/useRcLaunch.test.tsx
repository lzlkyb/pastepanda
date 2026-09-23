import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { useRcLaunch } from "@/hooks/useRcLaunch";

// useRcLaunch 的档位记忆落 localStorage；jsdom 同文件测试间共享存储，必须逐测清空
beforeEach(() => {
  localStorage.clear();
});

describe("远程连接的一步操作", () => {
  it("通道未启动时先开启通道，再向设备发起连接", async () => {
    const order: string[] = [];
    const rc = {
      status: { running: false },
      targets: [{ node_id: "peer-a", name: "工作电脑" }],
      startChannel: vi.fn(async () => { order.push("start"); return true; }),
      request: vi.fn(async () => { order.push("request"); return true; }),
    } as unknown as UseRc;
    const { result } = renderHook(() => useRcLaunch(rc, vi.fn()));

    await act(async () => { await result.current.doRequest("peer-a", "control"); });

    expect(order).toEqual(["start", "request"]);
  });

  it("开启通道失败时不发起必败连接", async () => {
    const rc = {
      status: { running: false },
      targets: [{ node_id: "peer-a", name: "工作电脑" }],
      startChannel: vi.fn(async () => false),
      request: vi.fn(async () => true),
    } as unknown as UseRc;
    const { result } = renderHook(() => useRcLaunch(rc, vi.fn()));

    await act(async () => { await result.current.doRequest("peer-a", "control"); });

    expect(rc.request).not.toHaveBeenCalled();
  });
});

describe("按设备记忆发起档（2026-09-23）", () => {
  const mkRc = () =>
    ({
      status: { running: true },
      targets: [
        { node_id: "peer-a", name: "甲" },
        { node_id: "peer-b", name: "乙" },
      ],
      request: vi.fn(async () => true),
    }) as unknown as UseRc;

  it("给一台选档只记那一台，全局默认档与其它设备不被改写", async () => {
    const rc = mkRc();
    const { result } = renderHook(() => useRcLaunch(rc, vi.fn()));

    // 全局默认档显式设为 control（出厂默认是 view，别依赖它）
    act(() => { result.current.setDefaultCap("control"); });
    expect(result.current.capOf("peer-a")).toBe("control");
    expect(result.current.capOf("peer-b")).toBe("control");

    // 给甲选「只看」发起成功
    await act(async () => { await result.current.doRequest("peer-a", "view"); });

    // 甲记忆 view；乙与全局仍是 control（串台回归守卫）
    expect(result.current.capOf("peer-a")).toBe("view");
    expect(result.current.capOf("peer-b")).toBe("control");
    expect(result.current.cap).toBe("control");
  });

  it("设置页改全局默认档后，没按设备记过的设备跟随新默认", async () => {
    const rc = mkRc();
    const { result } = renderHook(() => useRcLaunch(rc, vi.fn()));
    act(() => { result.current.setDefaultCap("control"); });

    await act(async () => { await result.current.doRequest("peer-a", "view"); });
    act(() => { result.current.setDefaultCap("view"); });

    // 甲仍按设备记忆 view；乙无记忆，跟随新全局
    expect(result.current.capOf("peer-a")).toBe("view");
    expect(result.current.capOf("peer-b")).toBe("view");
  });
});
