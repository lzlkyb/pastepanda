import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emit: vi.fn(async () => {}),
}));

const rcFileSnapshot = vi.fn();
const noop = vi.fn(async () => {});

vi.mock("@/lib/api/rcFile", () => ({
  rcFileSnapshot,
  rcFileCancel: noop,
  rcFileClearFinished: noop,
  rcFilePull: noop,
  rcFileRespond: noop,
  rcFileSend: noop,
}));

async function loadStore() {
  const mod = await import("@/stores/rcFileStore");
  return mod.useRcFileStore;
}

function taskSnap(done: number) {
  return {
    asks: [],
    tasks: [
      {
        id: "t1",
        peer: "n",
        peer_name: "p",
        dir: "recv",
        name: "a.zip",
        size: 100,
        offset: done,
        done,
        state: "transferring",
        started_ms: 1,
        updated_ms: 2,
      },
    ],
  };
}

describe("rcFileStore snapshot 代数（P1-11）", () => {
  beforeEach(() => {
    vi.resetModules();
    listenMock.mockReset();
    rcFileSnapshot.mockReset().mockResolvedValue({ asks: [], tasks: [] });
    noop.mockReset().mockResolvedValue(undefined);
  });

  it("事件到达后，在途旧 snapshot 作废（事件优先）", async () => {
    let eventCb: ((ev: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation(async (_n: string, cb: (ev: { payload: unknown }) => void) => {
      eventCb = cb;
      return () => {};
    });

    const useRcFileStore = await loadStore();
    useRcFileStore.getState().acquire();
    // 等 ensureListener + acquire 触发的首帧 refresh 都落地
    await vi.waitFor(() => expect(eventCb).not.toBeNull());
    await vi.waitFor(() => expect(rcFileSnapshot).toHaveBeenCalled());
    await Promise.resolve();
    rcFileSnapshot.mockClear();

    let resolveSnap!: (v: unknown) => void;
    const slow = new Promise((r) => {
      resolveSnap = r;
    });
    rcFileSnapshot.mockReturnValueOnce(slow);

    const p = useRcFileStore.getState().refresh();
    // 快照在途时，事件先到（done=80）
    eventCb!({ payload: taskSnap(80) });
    expect(useRcFileStore.getState().snapshot.tasks[0]?.done).toBe(80);

    // 旧 snapshot 终于回来（done=10）→ 必须丢弃
    resolveSnap(taskSnap(10));
    await p;
    expect(useRcFileStore.getState().snapshot.tasks[0]?.done).toBe(80);
  });

  it("更新的 refresh 落地后，更早的 snapshot 丢弃", async () => {
    listenMock.mockResolvedValue(() => {});
    const useRcFileStore = await loadStore();

    let resolveFirst!: (v: unknown) => void;
    const first = new Promise((r) => {
      resolveFirst = r;
    });
    rcFileSnapshot.mockReturnValueOnce(first).mockResolvedValueOnce(taskSnap(90));

    const p1 = useRcFileStore.getState().refresh();
    const p2 = useRcFileStore.getState().refresh();
    await p2;
    expect(useRcFileStore.getState().snapshot.tasks[0]?.done).toBe(90);

    resolveFirst(taskSnap(5));
    await p1;
    expect(useRcFileStore.getState().snapshot.tasks[0]?.done).toBe(90);
  });

  it("正常首帧 refresh 仍应用", async () => {
    listenMock.mockResolvedValue(() => {});
    rcFileSnapshot.mockResolvedValue(taskSnap(33));
    const useRcFileStore = await loadStore();
    await useRcFileStore.getState().refresh();
    expect(useRcFileStore.getState().snapshot.tasks[0]?.done).toBe(33);
  });

  it("设备页清空只移除此设备终态任务，全局入口仍兼容", async () => {
    const store = await loadStore();
    const base = taskSnap(33).tasks[0];
    store.getState().applySnapshot({ asks: [], tasks: [
      { ...base, id: "a-done", peer: "a", state: "done" },
      { ...base, id: "a-running", peer: "a" },
      { ...base, id: "b-failed", peer: "b", state: "failed" },
    ] });
    await store.getState().clearFinished("a");
    expect(noop).toHaveBeenCalledWith("a");
    expect(store.getState().snapshot.tasks.map((task) => task.id)).toEqual(["a-running", "b-failed"]);
    await store.getState().clearFinished();
    expect(store.getState().snapshot.tasks.map((task) => task.id)).toEqual(["a-running"]);
  });

  it("在途设备操作失败保留发起设备归属，刷新不抹掉失败", async () => {
    const store = await loadStore();
    let rejectSend!: (reason: string) => void;
    noop.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectSend = reject; }));
    const pending = store.getState().send("a", ["report.pdf"]);
    rejectSend("文件不可读");
    expect(await pending).toBe(false);
    expect(store.getState()).toMatchObject({ error: "文件不可读", errorPeer: "a", busy: false });
    await store.getState().refresh();
    expect(store.getState().error).toBe("文件不可读");
  });

  it("取消错误与接收响应错误根据任务和请求保留设备归属", async () => {
    const store = await loadStore();
    store.getState().applySnapshot({
      ...taskSnap(33),
      asks: [{ id: "ask1", peer: "b", peer_name: "B", kind: "push", name: "a.txt", size: 1, first_seen_ms: 1 }],
    });
    noop.mockRejectedValueOnce("取消失败");
    await store.getState().cancel("t1");
    expect(store.getState().errorPeer).toBe("n");
    noop.mockRejectedValueOnce("请求失效");
    await store.getState().respond("ask1", null);
    expect(store.getState().errorPeer).toBe("b");
  });
});
