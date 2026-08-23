/**
 * 分组 API — CRUD + 排序 + 移动记录
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, Group } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";
import { invalidateCountsCache } from "./cache";

/** 获取所有分组 */
export async function fetchGroups(): Promise<Group[]> {
  try {
    const groups = await invoke<Group[]>("get_groups");
    useAppStore.getState().setGroups(groups);
    return groups;
  } catch (e) {
    logger.error("获取分组失败", e);
    return [];
  }
}

/** 创建分组 */
export async function createGroup(name: string, color: string, icon: string): Promise<Group | null> {
  try {
    const group = await invoke<Group>("create_group", { name, color, icon });
    // 重新从后端获取，保证按 sort_order 排序，避免多客户端场景顺序错乱
    await fetchGroups();
    return group;
  } catch (e) {
    logger.error("创建分组失败", e);
    toastActionFailed("创建分组", e);
    return null;
  }
}

/** 更新分组 */
export async function updateGroup(id: string, name: string, color: string, icon: string): Promise<boolean> {
  try {
    await invoke("update_group", { id, name, color, icon });
    const store = useAppStore.getState();
    store.setGroups(store.groups.map((g) => (g.id === id ? { ...g, name, color, icon } : g)));
    return true;
  } catch (e) {
    logger.error("更新分组失败", e);
    toastActionFailed("更新分组", e);
    return false;
  }
}

/** 删除分组 */
export async function deleteGroup(id: string): Promise<boolean> {
  try {
    await invoke("delete_group", { id });
    // 更新本地 state：移除分组 + 将被删除分组的记录的 group_id 设为 null
    // 修复 M6：原地修改 history 不改变 length，必须手动清 _filterCache，否则筛选列表停滞
    useAppStore.setState((state) => ({
      groups: state.groups.filter((g) => g.id !== id),
      history: state.history.map((h) =>
        h.group_id === id ? { ...h, group_id: null as string | null } : h
      ),
      // 如果当前正在筛选此分组，重置筛选
      groupFilter: state.groupFilter === id ? "all" : state.groupFilter,
      _filterCache: null,
    }));
    invalidateCountsCache();
    return true;
  } catch (e) {
    logger.error("删除分组失败", e);
    toastActionFailed("删除分组", e);
    return false;
  }
}

/** 排序分组 */
export async function reorderGroups(ids: string[]): Promise<boolean> {
  try {
    await invoke("reorder_groups", { ids });
    const store = useAppStore.getState();
    const ordered = ids.map((id) => store.groups.find((g) => g.id === id)!).filter(Boolean);
    store.setGroups(ordered);
    return true;
  } catch (e) {
    logger.error("排序分组失败", e);
    toastActionFailed("排序分组", e);
    return false;
  }
}

/** 移动记录到分组 */
export async function moveToGroup(historyIds: string[], groupId: string | null): Promise<number> {
  try {
    const count = await invoke<number>("move_to_group", { historyIds, groupId });
    // 更新本地 state — 使用 setState 更新函数，避免丢失运行时状态
    // 修复 M6：原地修改 history 不改变 length，必须手动清 _filterCache
    useAppStore.setState((state) => ({
      history: state.history.map((h) => {
        if (historyIds.includes(h.id)) {
          return { ...h, group_id: groupId };
        }
        return h;
      }),
      _filterCache: null,
    }));
    invalidateCountsCache();
    return count;
  } catch (e) {
    logger.error("移动记录失败", e);
    toastActionFailed("移动记录", e);
    return 0;
  }
}
