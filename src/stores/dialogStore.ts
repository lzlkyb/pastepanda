import { create } from "zustand";
import type { HistoryItem } from "@/stores/appStore";

interface DialogState {
  /** 正在编辑的记录（非 null 时 ItemEditorDialog 打开） */
  editorItem: HistoryItem | null;
  openEditor: (item: HistoryItem) => void;
  closeEditor: () => void;
  /** 变换枢纽目标记录（非 null 时 TransformHubDialog 打开） */
  hubItem: HistoryItem | null;
  openHub: (item: HistoryItem) => void;
  closeHub: () => void;
}

/**
 * 弹窗状态 store — 统一编辑器入口（方案 A）。
 * 双击 / 右键「编辑内容」/ 悬停编辑 均调用 openEditor，
 * 由 ItemEditorDialog 按 editorRegistry 分派到具体编辑器。
 * 全屏编辑器已改为独立 OS 全屏窗口（Rust open_fullscreen_editor 命令，通用外壳），
 * 不再经由本 store。
 */
export const useDialogStore = create<DialogState>((set) => ({
  editorItem: null,
  openEditor: (item) => set({ editorItem: item }),
  closeEditor: () => set({ editorItem: null }),
  hubItem: null,
  openHub: (item) => set({ hubItem: item }),
  closeHub: () => set({ hubItem: null }),
}));
