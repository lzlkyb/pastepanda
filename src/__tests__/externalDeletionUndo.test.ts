/**
 * 🔴 批次④（P3，2026-10-24 拍板：撤销栈兜底）——
 * 「任何窗口删掉的记录，主窗口都能撤销」的守卫。
 *
 * 改前 `history-items-deleted` 广播处理只做本地过滤、不压撤销栈：
 * 从快捷粘贴面板 ✕ 掉的记录全应用无处可撤销（主窗撤销栈只收主窗
 * 自己的 deleteHistory 路径）。改前此用例为红。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyExternalDeletion } from "@/lib/api/init";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import { restoreDeleted } from "@/lib/api/history";

function seedItem(id: string): HistoryItem {
  return {
    id, text: `内容 ${id}`, time: "2026-01-01 12:00:00", type: "text",
    content: "", pinned: false, source: "clipboard", workspace: "默认",
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useAppStore.setState({ history: [seedItem("ext-1"), seedItem("ext-2")], undoStack: [] });
});

describe("applyExternalDeletion（外部窗口删除）", () => {
  it("删除后主窗撤销栈必须压栈（改前只过滤不压栈 = 无处可撤销）", () => {
    applyExternalDeletion(["ext-1"]);
    const s = useAppStore.getState();
    expect(s.history.find((h) => h.id === "ext-1"), "列表要移除").toBeUndefined();
    expect(s.undoStack.length).toBe(1);
    expect(s.undoStack[0][0].id).toBe("ext-1");
  });

  it("压了栈就能真撤销回来（restoreDeleted 走通）", async () => {
    applyExternalDeletion(["ext-1"]);
    const ok = await restoreDeleted();
    expect(ok).toBe(true);
    expect(useAppStore.getState().history.find((h) => h.id === "ext-1")).toBeTruthy();
  });
});
