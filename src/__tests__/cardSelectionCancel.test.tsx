import { afterEach, expect, it } from "vitest";
import { useAppStore } from "@/stores/appStore";
import { resolveKeyAction, type KeyEventHandlerState } from "@/lib/keyboardActions";
const initial = useAppStore.getState();
afterEach(() => useAppStore.setState({ selectedIds: initial.selectedIds, focusId: initial.focusId, lastClickedId: initial.lastClickedId }));
const state = { key: "Escape", ctrlKey: false, shiftKey: false, targetTagName: "DIV", ctxMenuOpen: false,
  showSettings: false, showSnippets: false, showExtract: false, showShortcuts: false, moveToGroup: false,
  fileDetailOpen: false, selectedIds: [], focusId: "a" } satisfies KeyEventHandlerState;
it("Esc 先清多选并保留位置，再清位置，最后才隐藏窗口", () => {
  useAppStore.setState({ selectedIds: new Set(["a", "b"]), focusId: "b", lastClickedId: "b" });
  useAppStore.getState().clearSelection(true);
  expect([...useAppStore.getState().selectedIds]).toEqual([]);
  expect(useAppStore.getState().focusId).toBe("b");
  expect(resolveKeyAction(state)).toEqual({ type: "clear_selection" });
  useAppStore.getState().clearSelection();
  expect(useAppStore.getState().focusId).toBeNull();
  expect(resolveKeyAction({ ...state, focusId: null })).toEqual({ type: "hide_window" });
});
it("非记录模式不被隐藏的卡片当前位置拦住 Esc", () => {
  expect(resolveKeyAction({ ...state, appMode: "knowledge" })).toEqual({ type: "hide_window" });
});
