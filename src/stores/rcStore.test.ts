import { beforeEach, describe, expect, it, vi } from "vitest";

const rcStatus = vi.fn();
const rcTargets = vi.fn(async () => [] as unknown[]);
const rcProbeTargets = vi.fn();
const rcClearOutboundError = vi.fn(async () => {});
const noop = vi.fn(async () => true);

vi.mock("@/lib/api/rc", () => ({
  rcStatus,
  rcTargets,
  rcClearOutboundError,
  rcApproveInbound: noop,
  rcCancelRequest: noop,
  rcDenyInbound: noop,
  rcDeviceAutoAcceptSet: noop,
  rcDeviceTrustSet: noop,
  rcEndSession: noop,
  rcForget: noop,
  rcHistoryClear: noop,
  rcIdentity: vi.fn(async () => null),
  rcInviteCreate: noop,
  rcInvitePreview: noop,
  rcJoinApprove: noop,
  rcJoinDeny: noop,
  rcPair: noop,
  rcRequestSession: noop,
  rcSetCapability: noop,
  rcSetDeviceAllowed: noop,
  rcSetEnabled: noop,
  rcProbeTargets,
  rcStartChannel: noop,
  rcSetQuality: noop,
  rcSetCaptureScope: noop,
  rcUnoGenerate: noop,
  rcUnoRevoke: noop,
  rcUnoPassEnable: noop,
  rcUnoPassDisable: noop,
  rcUnoPassSetWan: noop,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

async function loadStore() {
  const mod = await import("@/stores/rcStore");
  return mod.useRcStore;
}

function emptyStatus(over: Record<string, unknown> = {}) {
  return {
    session: null,
    pending: [],
    joins: [],
    outbound_error: null,
    running: true,
    ...over,
  } as never;
}

describe("rcStore refresh 代数（P1-11）", () => {
  beforeEach(async () => {
    vi.resetModules();
    rcStatus.mockReset();
    rcTargets.mockReset().mockResolvedValue([]);
    rcClearOutboundError.mockReset().mockResolvedValue(undefined);
  });

  it("慢响应落地时已被更新的请求取代 → 丢弃旧结果", async () => {
    const useRcStore = await loadStore();
    let resolveFirst!: (v: never) => void;
    const first = new Promise<never>((r) => {
      resolveFirst = r;
    });
    rcStatus
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(emptyStatus({ running: false }) as never);

    const p1 = useRcStore.getState().refresh();
    const p2 = useRcStore.getState().refresh();
    await p2;
    expect(useRcStore.getState().status?.running).toBe(false);

    resolveFirst(emptyStatus({ running: true }) as never);
    await p1;
    // 旧响应（running: true）不得覆盖新的 running: false
    expect(useRcStore.getState().status?.running).toBe(false);
  });

  it("旧响应的 statusError 也不得覆盖新状态", async () => {
    const useRcStore = await loadStore();
    let rejectFirst!: (e: unknown) => void;
    const first = new Promise<never>((_, r) => {
      rejectFirst = r;
    });
    rcStatus.mockReturnValueOnce(first).mockResolvedValueOnce(emptyStatus() as never);

    const p1 = useRcStore.getState().refresh();
    const p2 = useRcStore.getState().refresh();
    await p2;
    rejectFirst(new Error("stale network"));
    await p1;
    expect(useRcStore.getState().statusError).toBeNull();
  });
});

describe("设备可达性结果", () => {
  beforeEach(() => {
    vi.resetModules();
    rcStatus.mockReset().mockResolvedValue(emptyStatus() as never);
    rcTargets.mockReset().mockResolvedValue([]);
    rcProbeTargets.mockReset();
  });

  it("短连接的成功和失败结果分别留在内存中供设备行显示", async () => {
    const useRcStore = await loadStore();
    await useRcStore.getState().refresh();
    rcTargets.mockResolvedValue([
      { node_id: "peer-a", presence: "seen", source: "rc" },
      { node_id: "peer-b", presence: "never", source: "rc" },
    ]);
    rcProbeTargets.mockResolvedValue({ "peer-a": true, "peer-b": false });
    await useRcStore.getState().refreshTargets();

    await useRcStore.getState().probeTargets(["peer-a", "peer-b"]);

    expect(useRcStore.getState().reachability["peer-a"]?.state).toBe("reachable");
    expect(useRcStore.getState().reachability["peer-b"]?.state).toBe("unreachable");
  });

  it("设备列表读取失败保留旧设备并暴露错误，不伪装成空列表", async () => {
    const useRcStore = await loadStore();
    rcTargets.mockResolvedValueOnce([{ node_id: "peer-a", name: "工作电脑" }]);
    await useRcStore.getState().refreshTargets();
    rcTargets.mockRejectedValueOnce(new Error("读取失败"));

    await useRcStore.getState().refreshTargets();

    expect(useRcStore.getState().targets).toHaveLength(1);
    expect(useRcStore.getState().targetsError).toBe("读取失败");
  });

  it("较旧的设备列表响应不能覆盖新列表", async () => {
    const useRcStore = await loadStore();
    let releaseOld!: (value: unknown[]) => void;
    rcTargets.mockReturnValueOnce(new Promise((resolve) => { releaseOld = resolve; }));
    rcTargets.mockResolvedValueOnce([{ node_id: "peer-new" }]);
    const old = useRcStore.getState().refreshTargets();
    await useRcStore.getState().refreshTargets();
    releaseOld([{ node_id: "peer-old" }]);
    await old;
    expect(useRcStore.getState().targets[0]?.node_id).toBe("peer-new");
  });

  it("较旧的短连接结果不能覆盖同一设备的新结果", async () => {
    const useRcStore = await loadStore();
    await useRcStore.getState().refresh();
    rcTargets.mockResolvedValueOnce([{ node_id: "peer-a", source: "rc" }]);
    await useRcStore.getState().refreshTargets();
    let releaseOld!: (value: Record<string, boolean>) => void;
    rcProbeTargets.mockReturnValueOnce(new Promise((resolve) => { releaseOld = resolve; }));
    rcProbeTargets.mockResolvedValueOnce({ "peer-a": false });
    const old = useRcStore.getState().probeTargets(["peer-a"]);
    await useRcStore.getState().probeTargets(["peer-a"]);
    releaseOld({ "peer-a": true });
    await old;
    expect(useRcStore.getState().reachability["peer-a"]?.state).toBe("unreachable");
  });
});

describe("rcStore run 错误归属（P3-3）", () => {
  beforeEach(async () => {
    vi.resetModules();
    rcStatus.mockReset().mockResolvedValue(emptyStatus() as never);
    rcTargets.mockReset().mockResolvedValue([]);
  });

  it("新操作启动（入口）不抹掉已有 error", async () => {
    const useRcStore = await loadStore();
    await useRcStore.getState().run(async () => {
      throw new Error("A 失败了");
    });
    expect(useRcStore.getState().error).toBe("A 失败了");

    // 入口 set 是同步的：调用后立刻看，error 不得被抹掉
    const pB = useRcStore.getState().run(async () => {});
    expect(useRcStore.getState().error).toBe("A 失败了");
    await pB;
  });

  it("并发时：B 成功不得抹掉中途失败的 A", async () => {
    const useRcStore = await loadStore();
    let rejectA!: (e: unknown) => void;
    let resolveB!: () => void;
    const a = new Promise<never>((_, r) => {
      rejectA = r;
    });
    const gateB = new Promise<void>((r) => {
      resolveB = r;
    });

    const pA = useRcStore.getState().run(async () => {
      await a;
    });
    const pB = useRcStore.getState().run(async () => {
      await gateB;
    });

    rejectA(new Error("A 失败了"));
    await pA;
    expect(useRcStore.getState().error).toBe("A 失败了");

    resolveB();
    await pB;
    // B 在 A 失败之后才成功——不得抹掉 A 的错误
    expect(useRcStore.getState().error).toBe("A 失败了");
    expect(useRcStore.getState().busy).toBe(false);
  });

  it("单独成功路径才清 error", async () => {
    const useRcStore = await loadStore();
    const okFail = await useRcStore.getState().run(async () => {
      throw new Error("先失败");
    });
    expect(okFail).toBe(false);
    expect(useRcStore.getState().error).toBe("先失败");

    const ok = await useRcStore.getState().run(async () => {});
    expect(ok).toBe(true);
    expect(useRcStore.getState().error).toBeNull();
  });

  it("🔴 错误互抹：refresh 回显 outbound_error 也算「写过错误」，同 run 的成功路径不得清掉", async () => {
    // 修复前：refresh 写 error 不递增 errWrite，run 成功路径按「无人写过」清场
    // → 并发窗口里刚浮出的错误被抹掉，下一轮轮询再回显（错误条闪断）。
    const useRcStore = await loadStore();
    rcStatus.mockResolvedValue(
      emptyStatus({ outbound_error: { peer: "a", session_id: "s1", error: "backend boom" } }) as never,
    );
    // run 本体成功，但随后的 refresh 带回了 outbound_error
    const ok = await useRcStore.getState().run(async () => {});
    expect(ok).toBe(true);
    expect(useRcStore.getState().error).toBe("backend boom");
  });
});

describe("rcStore lastClearedError 短窗口（P3-4）", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    rcStatus.mockReset();
    rcTargets.mockReset().mockResolvedValue([]);
    rcClearOutboundError.mockReset().mockResolvedValue(undefined);
  });

  it("2s 内同串不回显，窗口过后同串算新错误", async () => {
    vi.setSystemTime(1_000_000);
    const useRcStore = await loadStore();
    rcStatus.mockResolvedValue(
      emptyStatus({ outbound_error: { peer: "a", session_id: "s1", error: "timeout once" } }) as never,
    );
    await useRcStore.getState().refresh();
    expect(useRcStore.getState().error).toBe("timeout once");

    useRcStore.getState().clearError();
    expect(useRcStore.getState().error).toBeNull();

    // 窗口内：轮询拿回同串 → 不回显
    await useRcStore.getState().refresh();
    expect(useRcStore.getState().error).toBeNull();

    // 窗口外（+2s）：同串视为真实新错误
    vi.setSystemTime(1_000_000 + 2_100);
    await useRcStore.getState().refresh();
    expect(useRcStore.getState().error).toBe("timeout once");
  });

  it("不同串始终回显", async () => {
    vi.setSystemTime(2_000_000);
    const useRcStore = await loadStore();
    rcStatus.mockResolvedValue(
      emptyStatus({ outbound_error: { peer: "a", session_id: "s1", error: "err-A" } }) as never,
    );
    await useRcStore.getState().refresh();
    useRcStore.getState().clearError();

    rcStatus.mockResolvedValue(
      emptyStatus({ outbound_error: { peer: "b", session_id: "s2", error: "err-B" } }) as never,
    );
    await useRcStore.getState().refresh();
    expect(useRcStore.getState().error).toBe("err-B");
  });
});
