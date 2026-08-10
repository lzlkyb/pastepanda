import { create } from "zustand";
import type { HistoryItem } from "@/stores/appStore";
import type { ChainDef } from "@/lib/api/chains";
import type { Chain } from "@/lib/chains/types";

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
  /** 动作链运行器（X1 B1）：非 null 时 ChainRunnerDialog 打开，文本是要处理的内容 */
  chainText: string | null;
  /** 打开时预选的链 id（M4 跑链建议用；空则默认第一条） */
  chainIdHint: string | null;
  /**
   * AI 临时编的链（B）。**不入库**，只在本次运行器会话内有效。
   *
   * 为何需要这个字段：运行器原本按 id 从注册表取链，而 AI 编的链不在注册表里。
   * 把它传进来而不是另建一个确认弹框，是为了直接复用运行器已有的逐步预览、
   * 失败定位、AI 步骤确认与粘贴——重建一份等于重写三百行。
   */
  chainAdHoc: Chain | null;
  openChain: (text: string, chainId?: string, adHoc?: Chain | null) => void;
  closeChain: () => void;
  /** 动作链编辑器（X1 B2）：非 null 时 ChainEditor 打开；传 null 表示新建 */
  chainEdit: ChainDef | null;
  openChainEditor: (chain: ChainDef | null) => void;
  closeChainEditor: () => void;
  /** 「系统学到了什么」（v6.1 红线②：学习日志可见可删） */
  learningsOpen: boolean;
  openLearnings: () => void;
  closeLearnings: () => void;
  /** 「我的画像」（M6-2/M6-3）：画像预览 + 导出 */
  profileOpen: boolean;
  openProfile: () => void;
  closeProfile: () => void;
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
  chainText: null,
  chainIdHint: null,
  chainAdHoc: null,
  openChain: (text, chainId, adHoc) =>
    set({ chainText: text, chainIdHint: chainId ?? null, chainAdHoc: adHoc ?? null }),
  // 关闭时必须清 chainAdHoc：不清的话下一次普通开链会把上次 AI 编的链带出来
  closeChain: () => set({ chainText: null, chainIdHint: null, chainAdHoc: null }),
  chainEdit: null,
  openChainEditor: (chain) => set({ chainEdit: chain }),
  closeChainEditor: () => set({ chainEdit: null }),
  learningsOpen: false,
  openLearnings: () => set({ learningsOpen: true }),
  closeLearnings: () => set({ learningsOpen: false }),
  profileOpen: false,
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
}));
