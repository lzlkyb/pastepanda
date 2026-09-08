/**
 * 「找回」信号 —— 搜完之后**真的把那条用了**，才算一次找回。
 *
 * ❗ 存在的理由是一个被证伪的旧口径：后端原先把每次搜索**返回的全部条目**
 *   批量 +1（上限 1000 条），而搜索框是 200ms 防抖、每个稳定下来的前缀
 *   各发一次查询。于是「找回 ×48」的真实含义是「在你过去的搜索结果里
 *   露过 48 次脸」——你一条都没点过。
 *   现场证据：库里 6 个不同条目的计数一模一样是 47、4 个是 48。
 *
 * 「当时在不在搜索」只有前端知道，所以判断放这边；后端只管加一。
 * 收成一个函数而不是在每个动作里各写一遍，是因为这个仓库已经为
 * 「粘贴信号漏了三个分支」付过一次代价（见 `logItemPasted` 的注释）。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";

/**
 * 若当前处于搜索状态，把这条记一次「找回」。
 *
 * fire-and-forget：统计失败不该影响用户刚做完的动作，连 toast 都不弹。
 */
export function markRecallIfSearching(id: string | null | undefined): void {
  if (!id) return;
  // 没关键词的路径（事件筛选等）不算：没搜过就谈不上「找回」。
  if (!useAppStore.getState().searchKeyword.trim()) return;
  void invoke("mark_search_recall", { id }).catch((e) => {
    logger.warn("找回计数上报失败", e);
  });
}
