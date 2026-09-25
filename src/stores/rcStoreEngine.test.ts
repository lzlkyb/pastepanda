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
      // 2026-09-25 起 ensureListener 半失败会安排自动重试，重试前检查
      // subscribers>0——fakeGet 给 1 表示「有订阅者常驻」（主窗场景）。
      subscribers: 1,
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
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
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

      // 首次失败已排了 2s 自动重试：手动重试成功后它应空转（不重复注册）
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listenMock).toHaveBeenCalledTimes(3 + 4);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("第一路就失败：什么都不留下，也不把 unlisteners 标脏", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      listenMock.mockRejectedValue(new Error("no tauri"));
      const { ensureListener } = await loadEngine();
      await ensureListener(fakeGet());
      await ensureListener(fakeGet()); // 仍会重试（unlisteners 空）
      // 每次只走到第 1 个 listen 就抛 → 各调用 1 次
      expect(listenMock).toHaveBeenCalledTimes(2);
      // 排空自动重试（最多 3 次），不把悬着的定时器漏给后续用例
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("🔴 半失败后 2s 自动重试并留痕（主窗常驻时一次启动期失败不能哑到重启）", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const offs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
      let i = 0;
      listenMock.mockImplementation(async () => {
        const idx = i++;
        if (idx === 2) throw new Error("listen boom");
        return offs[idx];
      });
      const { ensureListener } = await loadEngine();
      await ensureListener(fakeGet());
      // 失败必须 console.warn 留痕（不许静默）
      expect(warn).toHaveBeenCalledTimes(1);
      expect(offs[0]).toHaveBeenCalledTimes(1); // 已装的两路已回滚

      // 2s 后自动重试，这次全成功 → 四路装上
      i = 0;
      listenMock.mockImplementation(async () => offs[i++]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(listenMock).toHaveBeenCalledTimes(3 + 4);
      // 成功后不再排队重试
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listenMock).toHaveBeenCalledTimes(3 + 4);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("🔴 重试前检查 subscribers>0：订阅者已走光就不再装（等下次 acquire）", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      listenMock.mockRejectedValueOnce(new Error("down"));
      const { ensureListener } = await loadEngine();
      const getZero = () =>
        ({
          subscribers: 0,
          refresh: vi.fn(async () => {}),
          setScopeNotice: vi.fn(),
          setStreamNotice: vi.fn(),
          setPathNotice: vi.fn(),
        }) as unknown as RcState;
      await ensureListener(getZero); // 初次失败，安排重试
      expect(listenMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      // 订阅者归零：重试放空，listen 不再被调
      expect(listenMock).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("🔴 自动重试最多 3 次，防打转", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      listenMock.mockRejectedValue(new Error("down"));
      const { ensureListener } = await loadEngine();
      await ensureListener(fakeGet()); // 初次失败：1 次调用
      await vi.advanceTimersByTimeAsync(2_000); // 重试 1 → 2
      await vi.advanceTimersByTimeAsync(2_000); // 重试 2 → 3
      await vi.advanceTimersByTimeAsync(2_000); // 重试 3 → 4
      expect(listenMock).toHaveBeenCalledTimes(4);
      // 额度用尽：再推进也不打转
      await vi.advanceTimersByTimeAsync(30_000);
      expect(listenMock).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
