/**
 * 待沉淀区 API — 知识库 A 阶段（规划 §8.1 4️⃣，设计稿 §5）
 *
 * 对应 src-tauri/src/commands/kb_inbox.rs。
 *
 * ❗ **读取失败不弹 toast**：设计稿 §5-4 定了「永不弹 toast」——待沉淀区是个
 * 被动面板，它的任何动静都不应打断粘贴主流程。失败只进日志 + 横幅不出现。
 * **但用户主动点的「忽略」失败必须告知**（规则 #15.3）：那是他发起的动作，
 * 静默失败会让他以为已经忽略了，下次刷新又冒出来。
 */
import { invoke } from "@tauri-apps/api/core";
import type { HistoryItem } from "@/stores/appStore";
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";

/** 入选原因。后端算好传回，忽略时原样送回去写 dismissed.reason。 */
export type InboxReason = "star" | "research";

/** 一条待沉淀候选。 */
export interface InboxCandidate {
  item: HistoryItem;
  reason: InboxReason;
  search_hit_count: number;
  /** 有过 pasted 信号。仅同分时影响排序（A-28），也用于展示一个“用过”微标 */
  recently_pasted: boolean;
}

/** 当前工作区。候选是 history 卡片，而 history 查询全库都按工作区隔离。 */
function currentWorkspace(): string {
  return useAppStore.getState().config.current_workspace;
}

/** 候选列表。首屏 20 条（后端缺省），处理完再拉下一批。 */
export async function kbInboxList(limit?: number, offset = 0): Promise<InboxCandidate[]> {
  try {
    return await invoke<InboxCandidate[]>("kb_inbox_list", {
      workspace: currentWorkspace(),
      limit,
      offset,
    });
  } catch (e) {
    logger.warn("读取待沉淀候选失败", e);
    return [];
  }
}

/** 候选总数。失败返回 0 → 横幅不出现，而不是显示一个错的数。 */
export async function kbInboxCount(): Promise<number> {
  try {
    return await invoke<number>("kb_inbox_count", { workspace: currentWorkspace() });
  } catch (e) {
    logger.warn("统计待沉淀候选失败", e);
    return 0;
  }
}

/** 忽略一条。用户主动动作，失败必须告知。 */
export async function kbInboxDismiss(historyId: string, reason: InboxReason): Promise<boolean> {
  try {
    await invoke("kb_inbox_dismiss", { historyId, reason });
    return true;
  } catch (e) {
    logger.error("忽略候选失败", e);
    toastActionFailed("忽略", e);
    return false;
  }
}

/** 撤销忽略。 */
export async function kbInboxUndismiss(historyId: string): Promise<boolean> {
  try {
    await invoke("kb_inbox_undismiss", { historyId });
    return true;
  } catch (e) {
    logger.error("撤销忽略失败", e);
    toastActionFailed("撤销忽略", e);
    return false;
  }
}
