import { create } from "zustand";
import type { HistoryItem } from "@/stores/appStore";

interface DialogState {
  /** 正在编辑的记录（非 null 时 ItemEditorDialog 打开） */
  editorItem: HistoryItem | null;
  openEditor: (item: HistoryItem) => void;
  closeEditor: () => void;
}

/**
 * 弹窗状态 store — 统一编辑器入口（方案 A）。
 * 双击 / 右键「编辑内容」/ 悬停编辑 均调用 openEditor，
 * 由 ItemEditorDialog 按 editorRegistry 分派到具体编辑器。
 * 其余弹窗（二维码/对比/正则等）暂保持 CardList 局部状态。
 */
export const useDialogStore = create<DialogState>((set) => ({
  editorItem: null,
  openEditor: (item) => set({ editorItem: item }),
  closeEditor: () => set({ editorItem: null }),
}));
