import { describe, it, expect, vi, beforeEach } from "vitest";

// restoreDeleted 会写回后端 insert_history，测试中 mock 掉 Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { restoreDeleted, deleteHistory } from "@/lib/api/history";

function makeItem(overrides: Partial<HistoryItem> & { id: string; text: string }): HistoryItem {
  return {
    type: "text" as const,
    time: "2026-01-01 12:00:00",
    content: "",
    pinned: false,
    source: "clipboard",
    workspace: "默认",
    ...overrides,
  };
}

describe("restoreDeleted 链路（撤销删除）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      history: [],
      undoStack: [],
      _filterCache: null,
      selectedIds: new Set(),
      focusId: null,
      historyVersion: 0,
    } as any);
  });

  it("空撤销栈：返回 false 且不写回后端", async () => {
    const ok = await restoreDeleted();
    expect(ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("有撤销栈：恢复栈顶条目并写回 insert_history，撤销栈清空", async () => {
    const item = makeItem({ id: "a1", text: "hello" });
    useAppStore.setState({ history: [], undoStack: [[item]] } as any);
    const ok = await restoreDeleted();
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("insert_history", { item });
    expect(useAppStore.getState().history.some((h) => h.id === "a1")).toBe(true);
    expect(useAppStore.getState().undoStack).toHaveLength(0);
  });

  it("后端写回失败：回滚本地恢复并放回撤销栈", async () => {
    (invoke as any).mockRejectedValueOnce(new Error("boom"));
    const item = makeItem({ id: "b1", text: "x" });
    useAppStore.setState({ history: [], undoStack: [[item]] } as any);
    const ok = await restoreDeleted();
    expect(ok).toBe(true); // restored 非空即返回 true，失败项单独回滚
    expect(useAppStore.getState().history.some((h) => h.id === "b1")).toBe(false);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
  });

  it("搜索模式删除：从 searchResults 捕获并压栈，撤销可恢复且回到搜索结果", async () => {
    const item = makeItem({ id: "s1", text: "search hit" });
    useAppStore.setState({
      history: [],
      searchResults: [item],
      searchKeyword: "hit",
      undoStack: [],
      _filterCache: null,
      selectedIds: new Set(),
      focusId: null,
      historyVersion: 0,
    } as any);

    vi.mocked(invoke).mockResolvedValueOnce(1); // delete_history
    await deleteHistory(["s1"]);

    // 删除后应从 searchResults 移除（避免残留）
    expect(useAppStore.getState().searchResults).toHaveLength(0);
    // 且必须压入撤销栈（修复前：deleted 仅在 history 中查找，搜索模式为空 → 不压栈）
    expect(useAppStore.getState().undoStack).toHaveLength(1);

    vi.mocked(invoke).mockResolvedValueOnce(undefined); // insert_history 写回
    const ok = await restoreDeleted();
    expect(ok).toBe(true);
    expect(useAppStore.getState().undoStack).toHaveLength(0);
    // 撤销后回到搜索结果，列表重新可见
    expect(useAppStore.getState().searchResults?.some((h) => h.id === "s1")).toBe(true);
  });

  it("普通模式删除：从 history 捕获并压栈，撤销可恢复", async () => {
    const item = makeItem({ id: "n1", text: "normal item" });
    useAppStore.setState({
      history: [item],
      searchResults: null,
      searchKeyword: "",
      undoStack: [],
      _filterCache: null,
      selectedIds: new Set(),
      focusId: null,
      historyVersion: 0,
    } as any);

    vi.mocked(invoke).mockResolvedValueOnce(1); // delete_history
    await deleteHistory(["n1"]);

    expect(useAppStore.getState().history).toHaveLength(0);
    expect(useAppStore.getState().undoStack).toHaveLength(1); // 必须压栈

    vi.mocked(invoke).mockResolvedValueOnce(undefined); // insert_history 写回
    const ok = await restoreDeleted();
    expect(ok).toBe(true);
    expect(useAppStore.getState().undoStack).toHaveLength(0);
    expect(useAppStore.getState().history.some((h) => h.id === "n1")).toBe(true);
  });

  it("竞态防护：history 已被删除事件清空时，凭快照仍能压栈（撤销可用）", () => {
    // 模拟 history-items-deleted 事件在 removeItems 执行前已把 history 里的待删项过滤掉
    const item = makeItem({ id: "r1", text: "raced" });
    useAppStore.setState({
      history: [], // 事件已移除，history 中已无此条
      searchResults: null,
      undoStack: [],
      _filterCache: null,
      selectedIds: new Set(),
      focusId: null,
      historyVersion: 0,
    } as any);

    // deleteHistory 在 await 后端删除前已快照待删项，removeItems 据此压栈
    useAppStore.getState().removeItems(["r1"], [item]);

    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().undoStack[0][0].id).toBe("r1");
  });
});
