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
import type { InboxViewOpts } from "@/lib/notes/viewOpts";

/** 入选原因。后端算好传回，忽略时原样送回去写 dismissed.reason。 */
export type InboxReason = "star" | "research";

/** 一条待沉淀候选。 */
export interface InboxCandidate {
  item: HistoryItem;
  reason: InboxReason;
  search_hit_count: number;
  /** 有过 pasted 信号。仅同分时影响排序（A-28），也用于展示一个“用过”微标 */
  recently_pasted: boolean;
  /** 当前分组下的组键（B2 #9）。null = 不分组。
   *  存的是**原始值**（`code` / `Chrome` / `star`），中文名由前端映射——
   *  content_type → 中文的那份表就住在前端（CONTENT_TYPE_META），不在 Rust 里再写一份 */
  group_key?: string | null;
}

/** 当前工作区。候选是 history 卡片，而 history 查询全库都按工作区隔离。 */
function currentWorkspace(): string {
  return useAppStore.getState().config.current_workspace;
}

/** 候选列表。首屏 20 条（后端缺省），处理完再拉下一批。 */
export async function kbInboxList(
  limit?: number,
  offset = 0,
  view?: InboxViewOpts,
): Promise<InboxCandidate[]> {
  try {
    return await invoke<InboxCandidate[]>("kb_inbox_list", {
      workspace: currentWorkspace(),
      view: view ?? null,
      limit,
      offset,
    });
  } catch (e) {
    logger.warn("读取待沉淀候选失败", e);
    return [];
  }
}

/** 候选总数。失败返回 0 → 横幅不出现，而不是显示一个错的数。 */
export async function kbInboxCount(view?: InboxViewOpts): Promise<number> {
  try {
    return await invoke<number>("kb_inbox_count", {
      workspace: currentWorkspace(),
      view: view ?? null,
    });
  } catch (e) {
    logger.warn("统计待沉淀候选失败", e);
    return 0;
  }
}

/**
 * 每个分组的**真实**条数（B2 #9）。不分组时后端返回空数组。
 *
 * key 是原始值（content_type / source / reason），显示名由调用方映射。
 */
export async function kbInboxGroupCounts(view?: InboxViewOpts): Promise<Map<string, number>> {
  try {
    const rows = await invoke<{ key: string; count: number }[]>("kb_inbox_group_counts", {
      workspace: currentWorkspace(),
      view: view ?? null,
    });
    return new Map(rows.map((r) => [r.key, r.count]));
  } catch (e) {
    logger.warn("统计待沉淀分组条数失败", e);
    return new Map();
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
