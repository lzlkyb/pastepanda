import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsShell } from "./useSettingsShell";
import { useAppStore } from "@/stores/appStore";

vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({ status: "idle" }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset().mockResolvedValue(undefined); });

/**
 * 等排队里的写任务真的调到 invoke：mock 的 Promise executor 同步执行，
 * 用例手里的 reject 句柄到这一刻才被捕获。
 *
 * 为什么不用「微任务 flush 当就绪信号」的等法（await act 里只让渡 Promise.resolve）：
 * 那假定写一定在微任务里落地，被 tautologicalWaitGuard 禁——慢取数注入下紧接着的
 * 断言会读到空态首帧。等「调用真的发生」是不依赖落地时刻的真实条件。
 */
async function waitForSaveWriteStarted() {
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("save_config", expect.anything()));
}

describe("settings save continuity", () => {
  it("all failed queued writes restore the last persisted value, not an optimistic predecessor", async () => {
    useAppStore.getState().updateConfig({ auto_cleanup_days: 14 });
    vi.mocked(invoke).mockImplementation(command => command === "save_config"
      ? Promise.reject(new Error("disk denied")) : Promise.resolve(undefined));
    const { result } = renderHook(() => useSettingsShell());
    await act(async () => {
      const first = result.current.updateAndSave({ auto_cleanup_days: 15 });
      const second = result.current.updateAndSave({ auto_cleanup_days: 16 });
      await Promise.all([first, second]);
    });
    expect(useAppStore.getState().config.auto_cleanup_days).toBe(14);
  });

  it("a later failure keeps values already persisted by an earlier full-config write", async () => {
    useAppStore.getState().updateConfig({ note_trash_days: 1000 });
    let writes = 0;
    vi.mocked(invoke).mockImplementation(command => command === "save_config" && ++writes === 2
      ? Promise.reject(new Error("second write denied")) : Promise.resolve(undefined));
    const { result } = renderHook(() => useSettingsShell());
    await act(async () => {
      const first = result.current.updateAndSave({ note_trash_days: 2000 });
      const second = result.current.updateAndSave({ note_trash_days: 3000 });
      await Promise.all([first, second]);
    });
    expect(useAppStore.getState().config.note_trash_days).toBe(3000);
  });

  it("reopening the page retains an in-flight save and its failure state", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(invoke).mockImplementation(command => command === "save_config"
      ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve(undefined));
    const old = renderHook(() => useSettingsShell());
    let task!: Promise<boolean>;
    act(() => { task = old.result.current.updateAndSave({ theme: "midnight" }); });
    await waitForSaveWriteStarted();
    old.unmount();
    const fresh = renderHook(() => useSettingsShell());
    try { expect(fresh.result.current.saveState).toBe("pending"); }
    finally { await act(async () => { reject(new Error("save denied")); await task; }); }
    expect(fresh.result.current.saveState).toBe("error");
  });
  it("an earlier failed theme write cannot roll back a newer selection", async () => {
    useAppStore.getState().updateConfig({ theme: "ocean" });
    let rejectFirst!: (reason: Error) => void;
    let writes = 0;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "save_config" && ++writes === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useSettingsShell());
    let first!: Promise<boolean>, second!: Promise<boolean>;
    act(() => {
      first = result.current.updateAndSave({ theme: "dawn" });
      second = result.current.updateAndSave({ theme: "forest" });
    });
    await waitForSaveWriteStarted();
    await act(async () => { rejectFirst(new Error("write denied")); await first; await second; });
    expect(useAppStore.getState().config.theme).toBe("forest");
  });

  it("reopening settings does not let an old failure overwrite the same newer choice", async () => {
    useAppStore.getState().updateConfig({ theme: "ocean" });
    let rejectFirst!: (reason: Error) => void;
    let writes = 0;
    vi.mocked(invoke).mockImplementation(command => {
      if (command === "save_config" && ++writes === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return Promise.resolve(undefined);
    });
    const old = renderHook(() => useSettingsShell());
    let first!: Promise<boolean>;
    act(() => { first = old.result.current.updateAndSave({ theme: "dawn" }); });
    await waitForSaveWriteStarted();
    old.unmount();
    const fresh = renderHook(() => useSettingsShell());
    let second!: Promise<boolean>, third!: Promise<boolean>;
    act(() => {
      second = fresh.result.current.updateAndSave({ theme: "forest" });
      third = fresh.result.current.updateAndSave({ theme: "dawn" });
    });
    await act(async () => { rejectFirst(new Error("old write denied")); await first; await second; await third; });
    expect(useAppStore.getState().config.theme).toBe("dawn");
  });
});
