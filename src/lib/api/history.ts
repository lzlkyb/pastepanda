/**
 * 历史记录 API — 分页加载、删除、置顶
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { invalidateCountsCache, fetchCounts } from "./cache";

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
    // 用 DB 总数推导是否还有更多：appendHistory 会按 id 去重、且 store 可能淘汰超限条目，
    // 导致 history.length 增量小于返回条数，单靠 items.length>=50 会误判。
    const counts = await fetchCounts(store.config.current_workspace);
    const loaded = useAppStore.getState().history.length;
    if (counts.all >= loaded) return loaded < counts.all;
    return items.length >= 50; // 计数异常回退（如 stats 查询失败返回 0）
  } catch (e) {
    logger.warn("加载更多失败", e);
    return false;
  } finally {
    isLoadingMore = false;
  }
}

/** 全量搜索筛选参数（与后端 search_history 命令一一对应） */
export interface SearchFilters {
  search: string;
  /** "all" | "pinned" | 具体类型 */
  filter: string;
  /** "all" | "today" | "week" | "month" */
  timeFilter: string;
  /** "" 表示不按来源过滤 */
  source: string;
  /** "all" | "ungrouped" | 具体分组 id */
  groupFilter: string;
  tagIds: string[];
}

/**
 * 全量搜索：把全部筛选条件下推到后端 SQL，扫整表返回命中记录（上限 1000）。
 * 搜索模式专用——不再依赖分页加载的内存窗口，未加载的记录也能被搜到。
 * 注意：JS 侧参数名用 camelCase（Tauri 默认把 Rust snake_case 参数转为 camelCase）。
 */
export async function searchHistory(filters: SearchFilters, limit = 1000): Promise<HistoryItem[]> {
  const ws = useAppStore.getState().config.current_workspace;
  return await invoke<HistoryItem[]>("search_history", {
    workspace: ws,
    search: filters.search,
    filter: filters.filter,
    timeFilter: filters.timeFilter,
    source: filters.source,
    groupFilter: filters.groupFilter,
    tagIds: filters.tagIds,
    limit,
  });
}

/** 删除记录 */
export async function deleteHistory(ids: string[]) {
  try {
    const count = await invoke<number>("delete_history", { ids });
    const store = useAppStore.getState();
    store.removeItems(ids);
    invalidateCountsCache(); // 删除后清除缓存
    if (count > 0) {
      // 删除动画：通知列表开启行 glide 过渡窗口（与 pin-anim 机制一致），
      // 剩余行平滑让位，被删行由 AnimatePresence 播放退场
      window.dispatchEvent(new CustomEvent("delete-anim", { detail: { ids } }));
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已删除 ${count} 条记录（Ctrl+Z 撤销）`, type: "info" } }));
    }
    return count;
  } catch (e) {
    logger.error("删除失败", e);
    return 0;
  }
}

/** 置顶窗口重同步序列号：防止快速连续 toggle 时旧响应覆盖新数据 */
let resyncSeq = 0;

/**
 * 窗口重同步（Bug 2 修复）：置顶状态变更会改变后端 `pinned DESC, time DESC` 的全局行序，
 * 使 offset 分页窗口与 DB 前 L 行错位——取消置顶的项按 time 落回窗口外时，
 * 边界处新进入前 L 的记录会被后续 loadMore 跳过。
 * 重新拉取前 history.length 行整体替换窗口（setHistory 会递增 historyResetSeq，
 * useLoadMore 随之重置 hasMore），offset 重新对齐。
 * 失败时保留现有窗口（pin 状态已由 setPinned 局部更新，仅分页边界可能错位）。
 */
async function resyncWindow(): Promise<void> {
  const len = useAppStore.getState().history.length;
  if (len === 0) return;
  const seq = ++resyncSeq;
  try {
    const items = await invoke<HistoryItem[]>("get_history", {
      workspace: useAppStore.getState().config.current_workspace,
      filter: "all",
      search: "",
      offset: 0,
      limit: len,
    });
    if (seq !== resyncSeq) return; // 已有更新的重同步在飞行中，丢弃过期响应
    if (!Array.isArray(items)) return; // 防御：异常响应不写入 store
    useAppStore.getState().setHistory(items);
  } catch (e) {
    logger.warn("置顶后窗口重同步失败", e);
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
    // 方案 C 置顶动画：通知列表开启行 glide 过渡窗口（与 setPinned 的重排在同一帧渲染）
    window.dispatchEvent(new CustomEvent("pin-anim", { detail: { id, pinned } }));
    await resyncWindow(); // 全局行序已变，重同步分页窗口防 offset 漂移
    return pinned;
  } catch (e) {
    logger.error("切换置顶失败", e);
    return null; // U2：null 表示失败（区别于 false="取消置顶"成功），UI 层据此跳过 toast
  }
}

/** 深度清理组合条件（JS 侧 camelCase，Tauri 默认把 Rust snake_case 参数重命名） */
export interface DeepCleanConditions {
  /** 超过 N 天；null 表示不限时间 */
  beforeDays: number | null;
  /** "all" 表示不限，否则为 type 值（text / image / file） */
  itemType: string;
  /** "all" 表示不限，否则为来源应用名 */
  source: string;
}

/** 组装 invoke 参数：workspace 取当前工作区，"all" 转为 null（后端 Option 跳过该条件） */
function cleanArgs(c: DeepCleanConditions) {
  return {
    workspace: useAppStore.getState().config.current_workspace,
    beforeDays: c.beforeDays,
    itemType: c.itemType === "all" ? null : c.itemType,
    source: c.source === "all" ? null : c.source,
  };
}

/** 统计命中深度清理条件的记录数（后端 SQL 精确统计，不依赖分页内存） */
export async function countHistoryConditions(c: DeepCleanConditions): Promise<number> {
  return await invoke<number>("count_history_conditions", cleanArgs(c));
}

/** 深度清理预览：返回命中条件的前 limit 条记录（时间倒序） */
export async function previewHistoryConditions(
  c: DeepCleanConditions,
  limit = 50,
): Promise<HistoryItem[]> {
  return await invoke<HistoryItem[]>("preview_history_conditions", { ...cleanArgs(c), limit });
}

/**
 * 深度清理：删除命中条件的记录，同步本地列表并写入撤销栈
 * （与设置页自动清理的 executeCleanup 相同的 store 更新模式）。
 * 返回实际删除条数。
 */
export async function clearHistoryConditions(c: DeepCleanConditions): Promise<number> {
  const result = await invoke<{ count: number; deleted_items: HistoryItem[] }>(
    "clear_history_conditions",
    cleanArgs(c),
  );
  if (result.count > 0) {
    const deletedIds = new Set(result.deleted_items.map((d) => d.id));
    useAppStore.setState((s) => ({
      history: s.history.filter((h) => !deletedIds.has(h.id)),
      selectedIds: new Set([...s.selectedIds].filter((id) => !deletedIds.has(id))),
      _filterCache: null,
      // 手动清理属用户主动操作，保留撤销（与设置页清理一致）
      undoStack: [result.deleted_items, ...s.undoStack].slice(0, 10),
    }));
    invalidateCountsCache();
  }
  return result.count;
}
