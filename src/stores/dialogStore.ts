import { create } from "zustand";
import type { HistoryItem } from "@/stores/appStore";

interface DialogState {
  /** 正在编辑的记录（非 null 时 ItemEditorDialog 打开） */
  editorItem: HistoryItem | null;
  openEditor: (item: HistoryItem) => void;
  /**
   * 关闭编辑器。
   * - 不传 itemId：强制关闭（用户主动操作，如点击 X / Esc / 放弃确认），无条件清空。
   * - 传 itemId：仅当当前 editorItem 确实是该条目时才关闭；否则视为过期的异步回调，直接忽略。
   *   用于修复"编辑 A 保存中 → 切换编辑 B → A 的 save 才 resolve → 误关 B"的竞态（问题1）。
   */
  closeEditor: (itemId?: string) => void;
  /** 变换枢纽目标记录（非 null 时 TransformHubDialog 打开） */
  hubItem: HistoryItem | null;
  /**
   * 覆盖枢纽要处理的文本。
   *
   * 给图片预览里的“框选一块 → 拿这段文字去变换”用。不这样做的话，
   * 预览弹窗就得自己再搭一套动作列表，两份代码迟早漂。
   */
  hubText: string | null;
  openHub: (item: HistoryItem, overrideText?: string) => void;
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
  closeEditor: (itemId) =>
    set((state) => {
      // 未传 itemId：调用方明确要求强制关闭（用户主动点 X / Esc / 放弃确认）
      // 传了 itemId：只有当前正在编辑的条目确实是它时才真正关闭；
      // 否则是过期的异步回调（编辑 A 保存中途切换去编辑 B），直接忽略，避免误关 B 丢数据
      if (itemId !== undefined && state.editorItem?.id !== itemId) return state;
      return { editorItem: null };
    }),
  hubItem: null,
  hubText: null,
  openHub: (item, overrideText) =>
    set({ hubItem: item, hubText: overrideText ?? null }),
  closeHub: () => set({ hubItem: null, hubText: null }),
}));
