/**
 * 标签 API — CRUD + 记录标签关联 + 自动标签确认
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, Tag } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";

/** 获取所有标签 */
export async function fetchTags(): Promise<Tag[]> {
  try {
    const tags = await invoke<Tag[]>("get_tags");
    useAppStore.getState().setTags(tags);
    return tags;
  } catch (e) {
    logger.error("获取标签失败", e);
    return [];
  }
}

/** 创建标签 */
export async function createTag(name: string, color: string): Promise<Tag | null> {
  try {
    const tag = await invoke<Tag>("create_tag", { name, color });
    useAppStore.getState().setTags([...useAppStore.getState().tags, tag]);
    return tag;
  } catch (e) {
    logger.error("创建标签失败", e);
    toastActionFailed("创建标签", e);
    return null;
  }
}

/** 更新标签 */
export async function updateTag(id: string, name: string, color: string): Promise<boolean> {
  try {
    await invoke("update_tag", { id, name, color });
    const store = useAppStore.getState();
    store.setTags(store.tags.map((t) => (t.id === id ? { ...t, name, color } : t)));
    return true;
  } catch (e) {
    logger.error("更新标签失败", e);
    toastActionFailed("更新标签", e);
    return false;
  }
}

/** 删除标签 */
export async function deleteTag(id: string): Promise<boolean> {
  try {
    await invoke("delete_tag", { id });
    const store = useAppStore.getState();
    store.setTags(store.tags.filter((t) => t.id !== id));
    store.clearTagFilters();
    return true;
  } catch (e) {
    logger.error("删除标签失败", e);
    toastActionFailed("删除标签", e);
    return false;
  }
}

/** 设置记录标签（全量替换） */
export async function setItemTags(historyId: string, tagIds: string[]): Promise<boolean> {
  try {
    await invoke("set_item_tags", { historyId, tagIds });
    // 更新本地 state
    const store = useAppStore.getState();
    const allTags = store.tags;
    const newHistory = store.history.map((h) => {
      if (h.id === historyId) {
        return { ...h, tags: tagIds.map((tid) => allTags.find((t) => t.id === tid)!).filter(Boolean) };
      }
      return h;
    });
    // 修复 M6：标签变化不改变 history.length，必须手动清 _filterCache
    useAppStore.setState({ history: newHistory, _filterCache: null });
    return true;
  } catch (e) {
    logger.error("设置标签失败", e);
    toastActionFailed("设置标签", e);
    return false;
  }
}

/** 批量添加标签 */
export async function addItemTags(historyIds: string[], tagIds: string[]): Promise<number> {
  try {
    const count = await invoke<number>("add_item_tags", { historyIds, tagIds });
    // 更新本地 state
    const store = useAppStore.getState();
    const allTags = store.tags;
    const newTags = tagIds.map((tid) => allTags.find((t) => t.id === tid)!).filter(Boolean);
    const newHistory = store.history.map((h) => {
      if (historyIds.includes(h.id)) {
        const existing = h.tags || [];
        const merged = [...existing];
        for (const nt of newTags) {
          if (!merged.find((t) => t.id === nt.id)) merged.push(nt);
        }
        return { ...h, tags: merged };
      }
      return h;
    });
    // 修复 M6：标签变化不改变 history.length，必须手动清 _filterCache
    useAppStore.setState({ history: newHistory, _filterCache: null });
    return count;
  } catch (e) {
    logger.error("添加标签失败", e);
    toastActionFailed("添加标签", e);
    return 0;
  }
}

/** 批量移除标签 */
export async function removeItemTags(historyIds: string[], tagIds: string[]): Promise<number> {
  try {
    const count = await invoke<number>("remove_item_tags", { historyIds, tagIds });
    const store = useAppStore.getState();
    const newHistory = store.history.map((h) => {
      if (historyIds.includes(h.id)) {
        return { ...h, tags: (h.tags || []).filter((t) => !tagIds.includes(t.id)) };
      }
      return h;
    });
    // 修复 M6：标签变化不改变 history.length，必须手动清 _filterCache
    useAppStore.setState({ history: newHistory, _filterCache: null });
    return count;
  } catch (e) {
    logger.error("移除标签失败", e);
    toastActionFailed("移除标签", e);
    return 0;
  }
}

/** 批量获取记录标签 */
export async function getItemsWithTags(historyIds: string[]): Promise<Map<string, Tag[]>> {
  try {
    const result = await invoke<[string, Tag[]][]>("get_items_with_tags", { historyIds });
    return new Map(result);
  } catch (e) {
    logger.error("获取记录标签失败", e);
    return new Map();
  }
}

/** 确认自动标签（将指定记录的所有自动标签转为手动标签） */
export async function confirmAutoTags(historyId: string): Promise<boolean> {
  try {
    await invoke("confirm_auto_tags", { historyId });
    // 刷新标签列表
    const tags = await invoke<Tag[]>("get_tags");
    useAppStore.getState().setTags(tags);
    // 同步更新 history 中该 item 的 tags source 为 manual
    // 修复 M5 同类问题：基于最新 state 函数式更新，避免 await 前的过期快照覆盖整份 history
    useAppStore.setState((s) => ({
      history: s.history.map((item) => {
        if (item.id === historyId && item.tags) {
          return {
            ...item,
            tags: item.tags.map((t) => (t.source === "auto" ? { ...t, source: "manual" as const } : t)),
          };
        }
        return item;
      }),
      _filterCache: null,
    }));
    return true;
  } catch (e) {
    logger.error("确认自动标签失败", e);
    return false;
  }
}
