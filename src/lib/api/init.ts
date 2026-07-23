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

/**
 * 执行一次自动清理（启动时 + 周期性调用）。
 * 读取当前配置的 auto_cleanup_days，删除超期且未置顶的记录。
 * 返回被清理的条数（0 = 无需清理或配置无效）。
 */
async function runAutoCleanup(): Promise<number> {
  const cfg = useAppStore.getState().config;
  const days = Number(cfg.auto_cleanup_days);
  if (!Number.isFinite(days) || days <= 0) return 0;

  const result = await invoke<{ count: number; deleted_items: HistoryItem[] }>(
    "clear_history",
    { workspace: cfg.current_workspace, before_days: Math.floor(days) },
  );
  if (result.count > 0) {
    const fresh = await invoke<HistoryItem[]>("get_history", {
      workspace: cfg.current_workspace, filter: "all", search: "", offset: 0, limit: 50,
    });
    useAppStore.getState().setHistory(fresh);
    useAppStore.setState((s) => ({ undoStack: [result.deleted_items, ...s.undoStack].slice(0, 10) }));
    invalidateCountsCache();
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("app-toast", {
        detail: { message: `已自动清理 ${result.count} 条过期记录 (Ctrl+Z 撤销)`, type: "info" },
      }));
    }, 1000);
  }
  return result.count;
}

/** 周期性清理间隔：1 小时 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** 初始化 Tauri 后端连接 */
export async function initBackend(): Promise<() => void> {
  const store = useAppStore.getState();

  // 修复 C13：先加载配置 — history 必须用配置里的真实 workspace 拉取。
  // 旧顺序（先 history）在 workspace 非默认时用 DEFAULT_CONFIG 的 workspace 拉错数据，
  // config 加载后按真实 workspace 过滤 → 首屏空白，loadMore offset 也错位。
  let configLoaded = false;
  try {
    const config = await invoke<Record<string, unknown>>("get_config");
    store.updateConfig(config);
    configLoaded = true;
  } catch (e) {
    logger.error("加载配置失败，使用默认配置，跳过自动清理", e);
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

  // 启动时自动清理过期记录
  if (configLoaded) {
    try {
      await runAutoCleanup();
    } catch (e) { logger.warn("自动清理失败", e); }
  }

  // 周期性清理：托盘应用长期运行不重启，启动时清理一次不够 —
  // 每小时检查一次，确保运行期间超过保留天数的记录也能被及时清理
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  if (configLoaded) {
    cleanupTimer = setInterval(async () => {
      try {
        await runAutoCleanup();
      } catch (e) {
        logger.warn("周期性自动清理失败", e);
      }
    }, CLEANUP_INTERVAL_MS);
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
      const typeLabel = event.payload.item.type === "image" ? "图片" : event.payload.item.type === "file" ? "文件" : "文本";
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
    if (cleanupTimer) clearInterval(cleanupTimer);
    unlistens.forEach((u) => u());
  };
}
