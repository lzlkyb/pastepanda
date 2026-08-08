/**
 * 后端初始化 — 加载配置/数据 + 注册事件监听
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, HistoryItem, Tag } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { invalidateCountsCache } from "./cache";
import { sequentialPaste, indexPaste } from "./sequential";
import { toggleStackMode, stackPasteNext, stackPasteAll, isStackPasteAllRunning, abortStackPasteAll } from "./stack";

/** 初始化 Tauri 后端连接 */
export async function initBackend(): Promise<() => void> {
  const store = useAppStore.getState();

  // 修复 C13：先加载配置 — history 必须用配置里的真实 workspace 拉取。
  // 旧顺序（先 history）在 workspace 非默认时用 DEFAULT_CONFIG 的 workspace 拉错数据，
  // config 加载后按真实 workspace 过滤 → 首屏空白，loadMore offset 也错位。
  try {
    const config = await invoke<Record<string, unknown>>("get_config");
    store.updateConfig(config);
  } catch (e) {
    logger.error("加载配置失败，使用默认配置", e);
  }

  // 加载初始数据
  // 修复 M8：失败不再吞掉（此前 catch 仅 log，"无法加载数据"错误页实际不可达，
  // DB 损坏时用户看到空列表+正常 UI 误以为记录丢失）— 向上抛出，由 App 展示错误页
  const items = await invoke<HistoryItem[]>("get_history", {
    workspace: useAppStore.getState().config.current_workspace,
    filter: "all",
    search: "",
    offset: 0,
    limit: 50,
  });
  useAppStore.getState().setHistory(items);

  // 加载分组
  try {
    const groups = await invoke<import("@/stores/appStore").Group[]>("get_groups");
    store.setGroups(groups);
  } catch (e) {
    logger.warn("加载分组失败", e);
  }

  // 加载标签
  try {
    const tags = await invoke<Tag[]>("get_tags");
    store.setTags(tags);
  } catch (e) {
    logger.warn("加载标签失败", e);
  }

  // 注册云端 AI 动作（定义以后端为单一数据源，故在运行时拉取）。
  // 失败不影响其他功能——最多就是变换中心里没有 AI 那一组。
  try {
    const { initAiTransforms } = await import("@/lib/transforms");
    await initAiTransforms();
  } catch (e) {
    logger.warn("注册 AI 动作失败，变换中心将不显示 AI 分组", e);
  }

  // 修复 M7：统一收集 unlisten，任一 listen 失败时清理已注册的监听器，
  // 避免泄漏旧监听器导致重试后事件被双重处理
  const unlistens: Array<() => void> = [];
  try {
    // 监听剪贴板变化事件 — prependItem 内部已处理去重，无需手动判断
    unlistens.push(await listen<{ item: HistoryItem }>("clipboard-changed", (event) => {
      const store = useAppStore.getState();
      store.prependItem(event.payload.item);
      invalidateCountsCache(); // 新增记录，清除计数缓存
      const t = event.payload.item.type;
      const typeLabel = t === "image" ? "图片" : t === "rich" ? "图文" : t === "file" ? "文件" : "文本";
      const isLanSync = event.payload.item.source?.startsWith("局域网:");
      if (store.stackMode) {
        // 栈模式：入栈并使用专属提示
        const before = store.stackItems.length;
        store.stackPush(event.payload.item);
        const after = useAppStore.getState().stackItems.length;
        if (after > before) {
          window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `入栈 ${after} 条`, type: "info" } }));
        }
      } else {
        // U23：普通捕获静默记录（卡片出现在顶部即反馈），仅局域网同步这类"外部事件"才提示
        if (isLanSync) {
          const msg = `📡 ${event.payload.item.source!.replace("局域网: ", "")}同步了${typeLabel}`;
          window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: msg, type: "info" } }));
        }
      }
    }));

    // 监听标签更新事件（AI 自动分类完成后触发）
    unlistens.push(await listen<{ history_id: string; tag_ids: string[] }>("tags-updated", async (event) => {
      try {
        // 只刷新全局标签列表（标签选择器用）
        const tags = await invoke<Tag[]>("get_tags");
        useAppStore.getState().setTags(tags);
        // 修复 M5：基于"最新 state"函数式更新该 item 的标签 —
        // 旧实现用 await 前的过期快照 map 全量覆盖 history，会丢弃 await 期间新复制的条目；
        // 且 tag_ids 为空（清空全部标签）时也要更新，不能跳过
        const { history_id } = event.payload;
        if (history_id) {
          const itemsWithTags = await invoke<[string, Tag[]][]>("get_items_with_tags", {
            historyIds: [history_id],
          });
          const tagMap = new Map(itemsWithTags);
          const newTags = tagMap.get(history_id) || [];
          useAppStore.setState((s) => ({
            history: s.history.map((item) =>
              item.id === history_id ? { ...item, tags: newTags } : item
            ),
            _filterCache: null,
          }));
        }
      } catch (e) {
        logger.warn("刷新标签失败", e);
      }
    }));

    // 监听历史条目更新事件（全屏编辑器 update_history 后触发）
    // 图文混排（rich）保存时会多带 content（HTML 片段），普通文本只有 text；
    // content 为 undefined 时不能写进去，否则会把图片/文件条目的 content 抹成 undefined。
    unlistens.push(await listen<{ id: string; text: string; content?: string }>("history-item-updated", (event) => {
      const { id, text, content } = event.payload;
      if (!id) return;
      useAppStore.setState((s) => ({
        history: s.history.map((item) =>
          item.id === id
            ? { ...item, text, ...(content !== undefined ? { content } : {}) }
            : item
        ),
        _filterCache: null,
      }));
    }));

    // 监听历史删除事件（delete_history 命令广播）。
    // 删除可能来自快捷粘贴面板等独立窗口（与主窗口是不同的 React 实例、不共享 store），
    // 不接这个事件主窗口列表与侧边栏计数会一直是脏的。
    // 主窗口自己删除时也会收到本事件（app.emit 广播给所有窗口），
    // 但按 id 过滤是幂等的（已移除的再过滤一次无变化），不会影响已有的乐观更新与撤销栈。
    unlistens.push(await listen<{ ids: string[] }>("history-items-deleted", (event) => {
      const ids = event.payload?.ids;
      if (!Array.isArray(ids) || ids.length === 0) return;
      const deletedSet = new Set(ids);
      useAppStore.setState((s) => ({
        history: s.history.filter((h) => !deletedSet.has(h.id)),
        selectedIds: new Set([...s.selectedIds].filter((id) => !deletedSet.has(id))),
        focusId: s.focusId && deletedSet.has(s.focusId) ? null : s.focusId,
        _filterCache: null,
      }));
      invalidateCountsCache();
    }));

    // 监听自动清理完成事件（后端调度器启动首跑 + 每小时循环，替代原前端 setInterval）
    // 按事件携带的 deleted_ids 从内存列表精确移除，不重新拉取整页（避免列表被截断到首页）；
    // 策略性清理不属于用户误删，不写撤销栈，提示语也不带 Ctrl+Z
    unlistens.push(await listen<{ count: number; deleted_ids: string[] }>("auto-cleanup-done", (event) => {
      const { count, deleted_ids } = event.payload || {};
      if (!count || !Array.isArray(deleted_ids) || deleted_ids.length === 0) return;
      const deletedSet = new Set(deleted_ids);
      useAppStore.setState((s) => ({
        history: s.history.filter((h) => !deletedSet.has(h.id)),
        selectedIds: new Set([...s.selectedIds].filter((id) => !deletedSet.has(id))),
        focusId: s.focusId && deletedSet.has(s.focusId) ? null : s.focusId,
        _filterCache: null,
      }));
      invalidateCountsCache();
      window.dispatchEvent(new CustomEvent("app-toast", {
        detail: { message: `已自动清理 ${count} 条过期记录`, type: "info" },
      }));
    }));

    // 监听依次粘贴热键 (默认 Ctrl+Alt+Q)
    unlistens.push(await listen("hotkey-sequential-paste", async () => {
      console.log("[hotkey-sequential-paste] 事件收到，调用 sequentialPaste()");
      await sequentialPaste();
    }));

    // 监听索引粘贴热键 (Ctrl+Alt+1~9)
    unlistens.push(await listen<number>("hotkey-index-paste", async (event) => {
      await indexPaste(event.payload);
    }));

    // 监听剪贴板栈热键 (默认 Ctrl+Alt+K 切换 / Ctrl+Alt+P 粘贴)
    unlistens.push(await listen("hotkey-stack-toggle", () => {
      toggleStackMode();
    }));
    unlistens.push(await listen("hotkey-stack-paste", async () => {
      // U58：「全部粘贴」进行中再按粘贴热键 = 中止循环（全局可中止）
      if (isStackPasteAllRunning()) {
        abortStackPasteAll();
        return;
      }
      await stackPasteNext();
    }));
  } catch (e) {
    unlistens.forEach((u) => u());
    throw e;
  }

  // Ctrl+A 全选改为应用内快捷键，不再通过全局热键事件
  // 返回清理函数，在组件卸载时调用
  return () => {
    unlistens.forEach((u) => u());
  };
}
