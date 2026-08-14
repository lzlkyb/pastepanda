import { create } from "zustand";
import type { HistoryItem } from "@/stores/appStore";
import type { ChainDef } from "@/lib/api/chains";
import type { Chain } from "@/lib/chains/types";
import type { MilestoneEvent } from "@/lib/milestones";

export interface DialogState {
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
  /** 粘贴守卫（v6.2）：粘贴前敏感确认条（参考 ChainRunnerDialog 的 pendingAi promise 模式） */
  pasteGuard: {
    text: string;
    maskPreview: string;
    targetApp: string | null;
    resolve: (v: "mask" | "raw" | "cancel") => void;
  } | null;
  openPasteGuard: (p: {
    text: string;
    maskPreview: string;
    targetApp: string | null;
    resolve: (v: "mask" | "raw" | "cancel") => void;
  }) => void;
  closePasteGuard: () => void;
  /** 里程碑时刻（v6.8 粘性 B1）：非 null 时 MilestoneDialog 打开 */
  milestone: MilestoneEvent | null;
  openMilestone: (m: MilestoneEvent) => void;
  closeMilestone: () => void;
  /** 免费额度签到弹窗（v6.9）：true 时 QuotaDialog 打开 */
  quotaOpen: boolean;
  openQuota: () => void;
  closeQuota: () => void;
}

/**
 * 本 store 里是否有任何弹窗开着。
 *
 * **放在这里而不是让调用方自己枚举**：App.tsx 的全局键盘守卫原先手写了一串
 * `showSettings || showSnippets || …`，却漏了本 store 管的弹窗——于是开着卡片编辑弹框
 * 按 Delete/Backspace 会直接删掉主窗口选中的卡片（Esc 分层那边倒是考虑了 editorItem，
 * 两边一直不同步）。新增弹窗时只要在本文件补一处，不会再出现半边漏掉。
 *
 * 注：hubItem（变换枢纽）也在内——调用方已单独对它提前 return，重复包含无害。
 */
export function anyDialogOpen(s: DialogState): boolean {
  return Boolean(
    s.editorItem ||
      s.hubItem ||
      s.chainText ||
      s.chainEdit ||
      s.learningsOpen ||
      s.profileOpen ||
      s.pasteGuard ||
      s.milestone ||
      s.quotaOpen,
  );
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
  pasteGuard: null,
  openPasteGuard: (p) => set({ pasteGuard: p }),
  closePasteGuard: () => set({ pasteGuard: null }),
  milestone: null,
  openMilestone: (m) => set({ milestone: m }),
  closeMilestone: () => set({ milestone: null }),
  quotaOpen: false,
  openQuota: () => set({ quotaOpen: true }),
  closeQuota: () => set({ quotaOpen: false }),
}));
