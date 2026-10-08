import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useKnowledgeSync } from "./useKnowledgeSync";

const pc = {
  node_id: "pc",
  name: "My PC",
  paired_at: "today",
  transport: "",
  conn_state: "offline",
  last_seen: 0,
  relay_addr: "",
  sync_cursor_ms: 0,
  paused: false,
};
const offer = { node_id: "pc", name: "My PC", paired_at: "today" };
const report = {
  peer: "pc",
  at_ms: 100,
  last_ok_ms: 100,
  created: 1,
  updated: 0,
  deleted: 0,
  conflicts: 0,
  skipped_older: 0,
  missing_files: 0,
  import_failed: 0,
  assets_skipped: 0,
  fails: 0,
  clock_too_far_ahead_ms: null,
};
let devices: (typeof pc)[], last: (typeof report)[], enabled: boolean;
const calls = vi.mocked(invoke);

beforeEach(() => {
  devices = [];
  last = [];
  enabled = false;
  calls.mockReset();
  calls.mockImplementation(async (command) => {
    if (command === "kb_sync_devices") return { devices: [...devices], last: [...last], conflict_backlog: 0 };
    if (command === "rc_sync_offers") return [offer];
    if (command === "get_kb_sync_status") return enabled;
    if (command === "kb_sync_allow_from_rc") devices = [pc];
    if (command === "toggle_kb_sync") enabled = true;
    if (command === "kb_sync_set_paused") {
      devices = [{ ...pc, paused: true }];
      return true;
    }
    if (command === "kb_sync_forget") {
      devices = [];
      return true;
    }
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mobile knowledge sync data boundaries", () => {
  it("RC offers do not automatically authorize or turn on sync", async () => {
    const { result } = renderHook(() => useKnowledgeSync(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.offers).toEqual([offer]);
    expect(
      calls.mock.calls.some(([command]) => command === "kb_sync_allow_from_rc" || command === "toggle_kb_sync"),
    ).toBe(false);
    await act(async () => {
      await result.current.authorize(offer);
    });
    expect(calls).toHaveBeenCalledWith("kb_sync_allow_from_rc", { nodeId: "pc", name: "My PC" });
    expect(result.current.feedback?.title).toBe("已授权并开启同步");
  });
  it("a second computer cannot silently merge with the already authorized library", async () => {
    devices = [{ ...pc, node_id: "other" }];
    const { result } = renderHook(() => useKnowledgeSync(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      expect(await result.current.authorize(offer)).toBe(false);
    });
    expect(calls.mock.calls.some(([cmd]) => cmd === "kb_sync_allow_from_rc")).toBe(false);
    expect(result.current.feedback?.tone).toBe("error");
  });
  it("a computer removed while the consent sheet was open is not authorized", async () => {
    const { result } = renderHook(() => useKnowledgeSync(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const original = calls.getMockImplementation()!;
    calls.mockImplementation((cmd, args) => cmd === "rc_sync_offers" ? Promise.resolve([]) : original(cmd, args));
    await act(async () => { expect(await result.current.authorize(offer)).toBe(false); });
    expect(calls.mock.calls.some(([cmd]) => cmd === "kb_sync_allow_from_rc" || cmd === "toggle_kb_sync")).toBe(false);
  });
  it("a resolved sync command without a fresh report is not a success receipt", async () => {
    devices = [pc];
    enabled = true;
    last = [report];
    const { result } = renderHook(() => useKnowledgeSync(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.sync(pc);
    });
    expect(result.current.feedback?.tone).toBe("info");
    expect(result.current.feedback?.detail).toContain("尚未取得本轮成功报告");
  });
  it("partial import and outgoing image failure remain a warning with real counts", async () => {
    devices = [pc];
    enabled = true;
    const original = calls.getMockImplementation()!;
    calls.mockImplementation(async (cmd, args) => {
      if (cmd === "kb_sync_now") last = [{ ...report, import_failed: 2, assets_skipped: 1 }];
      return original(cmd, args);
    });
    const changed = vi.fn();
    const { result } = renderHook(() => useKnowledgeSync(true, changed));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.sync(pc);
    });
    expect(result.current.feedback?.tone).toBe("warning");
    expect(result.current.last[0].import_failed).toBe(2);
    expect(changed).toHaveBeenCalled();
  });
  it("cancel interrupts pending sync and its late error cannot overwrite cancellation feedback", async () => {
    devices = [pc];
    enabled = true;
    let rejectSync: (reason: Error) => void = () => {};
    const pending = new Promise<void>((_, reject) => {
      rejectSync = reject;
    });
    const original = calls.getMockImplementation()!;
    calls.mockImplementation((cmd, args) => (cmd === "kb_sync_now" ? pending : original(cmd, args)));
    const { result } = renderHook(() => useKnowledgeSync(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let task: Promise<boolean>;
    act(() => {
      task = result.current.sync(pc);
    });
    await waitFor(() => expect(calls.mock.calls.some(([cmd]) => cmd === "kb_sync_now")).toBe(true));
    await act(async () => {
      await result.current.cancel(pc);
    });
    expect(result.current.feedback?.title).toBe("已取消并暂停同步");
    await act(async () => {
      rejectSync(new Error("cancelled"));
      await task!;
    });
    expect(result.current.feedback?.title).toBe("已取消并暂停同步");
    expect(result.current.busy).toBe("");
    expect(calls.mock.calls.some(([cmd]) => cmd === "note_delete")).toBe(false);
  });
  it("revocation keeps local data and only removes KB authorization", async () => {
    devices = [pc];
    const { result } = renderHook(() => useKnowledgeSync(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.revoke(pc);
    });
    expect(calls).toHaveBeenCalledWith("kb_sync_forget", { nodeId: "pc" });
    expect(calls.mock.calls.some(([cmd]) => cmd === "note_delete" || cmd === "rc_forget")).toBe(false);
    expect(result.current.feedback?.detail).toContain("本机笔记与草稿保留");
  });
  it("one polling owner stops in the background and on inactive navigation", async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const { rerender, unmount } = renderHook(({ active }) => useKnowledgeSync(active), {
      initialProps: { active: true },
    });
    await act(async () => {});
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(0);
    const before = calls.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(45000);
    });
    expect(calls.mock.calls.length).toBe(before);
    act(() => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {});
    expect(vi.getTimerCount()).toBe(1);
    rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
