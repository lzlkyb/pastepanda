import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RcState } from "@/stores/rcStoreTypes";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emit: vi.fn(async () => {}),
}));

function fakeGet(): () => RcState {
  return () =>
    ({
      refresh: vi.fn(async () => {}),
      setScopeNotice: vi.fn(),
      setStreamNotice: vi.fn(),
      setPathNotice: vi.fn(),
    }) as unknown as RcState;
}

async function loadEngine() {
  return await import("@/stores/rcStoreEngine");
}

describe("ensureListener", () => {
  beforeEach(() => {
    vi.resetModules();
    listenMock.mockReset();
  });

  it("全部成功：装 4 路，再次调用不重复注册", async () => {
    const offs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let i = 0;
    listenMock.mockImplementation(async () => offs[i++]);
    const { ensureListener } = await loadEngine();
    await ensureListener(fakeGet());
    expect(listenMock).toHaveBeenCalledTimes(4);
    await ensureListener(fakeGet());
    expect(listenMock).toHaveBeenCalledTimes(4); // 不重装
  });

  it("P1-7：半失败回滚已装的 unlisten，下次可干净重试", async () => {
    const offs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let i = 0;
    listenMock.mockImplementation(async () => {
      const idx = i++;
      if (idx === 2) throw new Error("listen boom");
      return offs[idx];
    });
    const { ensureListener } = await loadEngine();
    await ensureListener(fakeGet());
    // 前两路装上后必须被卸掉——否则泄漏 + 下次重复注册
    expect(offs[0]).toHaveBeenCalledTimes(1);
    expect(offs[1]).toHaveBeenCalledTimes(1);
    expect(offs[2]).not.toHaveBeenCalled();

    // 重试：这次全部成功
    i = 0;
    listenMock.mockImplementation(async () => offs[i++]);
    await ensureListener(fakeGet());
    expect(listenMock).toHaveBeenCalledTimes(3 + 4);
  });

  it("第一路就失败：什么都不留下，也不把 unlisteners 标脏", async () => {
    listenMock.mockRejectedValue(new Error("no tauri"));
    const { ensureListener } = await loadEngine();
    await ensureListener(fakeGet());
    await ensureListener(fakeGet()); // 仍会重试（unlisteners 空）
    // 每次只走到第 1 个 listen 就抛 → 各调用 1 次
    expect(listenMock).toHaveBeenCalledTimes(2);
  });
});
