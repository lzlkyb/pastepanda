/**
 * 历史记录 API — 分页加载、删除、置顶
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { invalidateCountsCache } from "./cache";

/** 分页在飞行中标志位：防止连续滑动触发两次 loadMoreHistory 并发请求同一页导致重复行 */
let isLoadingMore = false;

/** 加载更多历史记录（分页） */
export async function loadMoreHistory(): Promise<boolean> {
  if (isLoadingMore) return false; // 已有请求在飞行中，直接返回，避免重复请求/重复行
  isLoadingMore = true;
  const store = useAppStore.getState();
  const currentCount = store.history.length;
  try {
    const items = await invoke<HistoryItem[]>("get_history", {
      workspace: store.config.current_workspace,
      filter: "all",
      search: "",
      offset: currentCount,
      limit: 50,
    });
    if (items.length === 0) return false;
    store.appendHistory(items);
    return items.length >= 50; // 还有更多
  } catch (e) {
    logger.warn("加载更多失败", e);
    return false;
  } finally {
    isLoadingMore = false;
  }
}

/** 删除记录 */
export async function deleteHistory(ids: string[]) {
  try {
    const count = await invoke<number>("delete_history", { ids });
    const store = useAppStore.getState();
    store.removeItems(ids);
    invalidateCountsCache(); // 删除后清除缓存
    if (count > 0) {
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已删除 ${count} 条记录（Ctrl+Z 撤销）`, type: "info" } }));
    }
    return count;
  } catch (e) {
    logger.error("删除失败", e);
    return 0;
  }
}

/** 切换置顶 */
export async function togglePin(id: string): Promise<boolean | null> {
  try {
    const pinned = await invoke<boolean>("toggle_pin", { id });
    const store = useAppStore.getState();
    // 使用后端返回的权威 pinned 值直接设置，而非盲目本地取反（本地/后端状态可能因局域网同步等原因已经漂移）
    store.setPinned(id, pinned);
    invalidateCountsCache(); // 置顶状态变化后清除缓存
    return pinned;
  } catch (e) {
    logger.error("切换置顶失败", e);
    return null; // U2：null 表示失败（区别于 false="取消置顶"成功），UI 层据此跳过 toast
  }
}
