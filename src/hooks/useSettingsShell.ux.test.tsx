import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useSettingsShell } from "./useSettingsShell";
import { useAppStore } from "@/stores/appStore";

const { toast, open, readTextFile } = vi.hoisted(() => ({ toast: vi.fn(), open: vi.fn(), readTextFile: vi.fn() }));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({ status: "idle" }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile }));
beforeEach(() => {
  toast.mockClear();
  vi.mocked(emit).mockClear();
  useAppStore.getState().updateConfig({ theme: "ocean", hotkey: "Ctrl+Q" });
  open.mockResolvedValue("backup.json");
  readTextFile.mockResolvedValue(JSON.stringify([{ id: "1", text: "entry", time: "2026-10-17", type: "text" }]));
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

it("failed reset does not announce success or register hotkeys", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "save_config" ? Promise.reject(new Error("disk denied")) : Promise.resolve(undefined));
  const { result } = renderHook(() => useSettingsShell());
  await act(async () => { await result.current.handleResetDefaults(); });
  expect(toast).not.toHaveBeenCalledWith("已恢复默认设置", "success");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "reregister_hotkeys")).toBe(false);
});

it("failed theme save broadcasts the restored theme to other windows", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "save_config" ? Promise.reject(new Error("disk denied")) : Promise.resolve(undefined));
  const { result } = renderHook(() => useSettingsShell());
  await act(async () => { await result.current.updateAndSave({ theme: "midnight" }); });
  expect(emit).toHaveBeenLastCalledWith("theme-changed", { theme: "ocean" });
});

it("duplicate imports report zero newly added records", async () => {
  vi.mocked(invoke).mockImplementation(command => Promise.resolve(command === "import_history" ? 0 : command === "get_history" ? [] : undefined));
  const { result } = renderHook(() => useSettingsShell());
  await act(async () => { await result.current.handleImport(); });
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/新增 0 条.*1 条.*已存在/), "info");
});

it("refresh failure after a committed import is reported as partial success", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "get_history" ? Promise.reject(new Error("refresh failed")) : Promise.resolve(command === "import_history" ? 1 : undefined));
  const { result } = renderHook(() => useSettingsShell());
  await act(async () => { await result.current.handleImport(); });
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/已导入 1 条.*刷新失败/), "warning");
  expect(toast).not.toHaveBeenCalledWith("导入失败", "error");
});

it("a failed statistics query shows a retry state instead of endless loading", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "get_stats_detail" ? Promise.reject(new Error("database denied")) : Promise.resolve(undefined));
  const { result } = renderHook(() => useSettingsShell());
  await act(async () => {});
  expect(result.current.statsError).toBe(true);
});

it("switching workspaces prevents old statistics overwriting the current workspace", async () => {
  useAppStore.getState().updateConfig({ current_workspace: "old" });
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command !== "get_stats_detail") return Promise.resolve(undefined);
    return (args as { workspace: string }).workspace === "old" ? new Promise(done => { resolve = done; }) : Promise.resolve({ total: 7 });
  });
  const { result } = renderHook(() => useSettingsShell());
  await act(async () => { useAppStore.getState().updateConfig({ current_workspace: "new" }); });
  await act(async () => { resolve({ total: 99 }); });
  expect(result.current.stats?.total).toBe(7);
});
