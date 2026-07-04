import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { logger } from "@/lib/logger";

/** 加载更多历史记录（分页） */
export async function loadMoreHistory(): Promise<boolean> {
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
  }
}

/** 初始化 Tauri 后端连接 */
export async function initBackend(): Promise<() => void> {
  const store = useAppStore.getState();

  // 加载初始数据
  try {
    const items = await invoke<HistoryItem[]>("get_history", {
      workspace: store.config.current_workspace,
      filter: "all",
      search: "",
      offset: 0,
      limit: 50,
    });
    store.setHistory(items);
  } catch (e) {
    logger.error("加载历史记录失败", e);
  }

  // 加载配置
  let configLoaded = false;
  try {
    const config = await invoke<Record<string, unknown>>("get_config");
    store.updateConfig(config);
    configLoaded = true;
  } catch (e) {
    logger.error("加载配置失败，使用默认配置，跳过自动清理", e);
  }

  // 启动时自动清理过期记录
  if (configLoaded) {
    try {
      const cfg = useAppStore.getState().config;
      // 确保 auto_cleanup_days 是有效正整数（防止字符串类型导致参数错误）
      const days = Number(cfg.auto_cleanup_days);
      if (Number.isFinite(days) && days > 0) {
        // before_days 显式传正整数，Rust 端已加固：None 或 0 不删除任何记录
        const result = await invoke<{ count: number; deleted_items: HistoryItem[] }>("clear_history", { workspace: cfg.current_workspace, before_days: Math.floor(days) });
        if (result.count > 0) {
          const fresh = await invoke<HistoryItem[]>("get_history", { workspace: cfg.current_workspace, filter: "all", search: "", offset: 0, limit: 50 });
          // 将清理的记录保存到撤销栈，支持 Ctrl+Z 恢复
          useAppStore.getState().setHistory(fresh);
          useAppStore.setState((s) => ({ undoStack: [result.deleted_items, ...s.undoStack].slice(0, 10) }));
          // 清理后清除计数缓存，下次渲染会自动查后端
          invalidateCountsCache();
          setTimeout(() => {
            const event = new CustomEvent("app-toast", { detail: { message: `已自动清理 ${result.count} 条过期记录 (Ctrl+Z 撤销)`, type: "info" } });
            window.dispatchEvent(event);
          }, 1000);
        }
      }
    } catch (e) { logger.warn("自动清理失败", e); }
  }

  // 监听剪贴板变化事件 — prependItem 内部已处理去重，无需手动判断
  const unlisten1 = await listen<{ item: HistoryItem }>("clipboard-changed", (event) => {
    const store = useAppStore.getState();
    store.prependItem(event.payload.item);
    invalidateCountsCache(); // 新增记录，清除计数缓存
    const typeLabel = event.payload.item.type === "image" ? "图片" : event.payload.item.type === "file" ? "文件" : "文本";
    const isLanSync = event.payload.item.source?.startsWith("局域网:");
    const msg = isLanSync ? `📡 ${event.payload.item.source.replace("局域网: ", "")}同步了${typeLabel}` : `已记录${typeLabel}`;
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: msg, type: isLanSync ? "info" : "success" } }));
  });

  // 监听依次粘贴热键 (Ctrl+Q)
  const unlisten2 = await listen("hotkey-sequential-paste", async () => {
    await sequentialPaste();
  });

  // 监听索引粘贴热键 (Ctrl+Alt+1~9)
  const unlisten3 = await listen<number>("hotkey-index-paste", async (event) => {
    await indexPaste(event.payload);
  });

  // Ctrl+A 全选改为应用内快捷键，不再通过全局热键事件
  // 返回清理函数，在组件卸载时调用
  return () => {
    unlisten1();
    unlisten2();
    unlisten3();
  };
}

/** 依次粘贴：粘贴当前指针指向的文本，然后指针+1 */
export async function sequentialPaste() {
  const store = useAppStore.getState();
  const textItems = store.history.filter((h) => h.type === "text");
  const pointer = store.seqPointer;
  const loop = store.config.sequential_loop;

  if (textItems.length === 0) {
    return;
  }

  let idx = pointer;
  if (idx >= textItems.length) {
    if (loop) {
      idx = 0;
      store.setSeqPointer(0);
    } else {
      return; // 到头了
    }
  }

  const item = textItems[idx];
  if (!item) {
    return;
  }

  // 调用后端粘贴引擎
  await pasteText(item.text);

  // Toast 反馈
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴第 ${idx + 1} 条`, type: "success" } }));

  // 推进指针
  const next = idx + 1;
  if (next >= textItems.length) {
    if (loop) {
      store.setSeqPointer(0);
    } else {
      store.setSeqPointer(next);
    }
  } else {
    store.setSeqPointer(next);
  }
}

/** 索引粘贴：粘贴第 N 条文本记录 (1-based) */
export async function indexPaste(n: number) {
  const store = useAppStore.getState();
  const textItems = store.history.filter((h) => h.type === "text");
  const idx = n - 1; // 转为 0-based

  if (idx < 0 || idx >= textItems.length) return;

  const item = textItems[idx];
  if (!item) return;

  await pasteText(item.text);
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴第 ${n} 条`, type: "success" } }));
}

/** 粘贴文本 */
export async function pasteText(text: string) {
  try {
    await invoke("paste_text", { text });
  } catch (e) {
    logger.error("粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `粘贴失败: ${msg}`, type: "error" } }));
  }
}

/** 粘贴图片 */
export async function pasteImage(imagePath: string) {
  try {
    await invoke("paste_image", { imagePath });
  } catch (e) {
    logger.error("图片粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `图片粘贴失败: ${msg}`, type: "error" } }));
  }
}

/** 仅复制 */
export async function copyOnly(text: string) {
  try {
    await invoke("copy_only", { text });
  } catch (e) {
    logger.error("复制失败", e);
  }
}

/** 保存前台窗口句柄 */
export async function saveForeground() {
  try {
    await invoke("save_foreground");
  } catch (e) {
    logger.error("保存前台句柄失败", e);
  }
}

/** 切换窗口显示 */
export async function toggleWindow() {
  try {
    await invoke("toggle_window");
  } catch (e) {
    logger.error("切换窗口失败", e);
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
export async function togglePin(id: string) {
  try {
    const pinned = await invoke<boolean>("toggle_pin", { id });
    const store = useAppStore.getState();
    store.togglePin(id);
    invalidateCountsCache(); // 置顶状态变化后清除缓存
    return pinned;
  } catch (e) {
    logger.error("切换置顶失败", e);
    return false;
  }
}

/** 获取统计数据 */
export interface Stats {
  total: number;
  pinned: number;
  today: number;
  text_count: number;
  image_count: number;
  file_count: number;
  earliest_time: string | null;
  db_size_kb: number;
}

export async function getStats(workspace: string): Promise<Stats> {
  try {
    return await invoke<Stats>(
      "get_stats",
      { workspace }
    );
  } catch (e) {
    logger.error("获取统计失败", e);
    return { total: 0, pinned: 0, today: 0, text_count: 0, image_count: 0, file_count: 0, earliest_time: null, db_size_kb: 0 };
  }
}

/** Tab 计数缓存（30 秒过期，按工作区分） */
let countsCache: { workspace: string; counts: { all: number; text: number; image: number; file: number; pinned: number }; ts: number } | null = null;
const COUNTS_CACHE_MS = 30_000;

/** 获取 Tab 计数（带 30 秒缓存，避免频繁查后端） */
export async function fetchCounts(workspace: string): Promise<{ all: number; text: number; image: number; file: number; pinned: number }> {
  if (countsCache && countsCache.workspace === workspace && Date.now() - countsCache.ts < COUNTS_CACHE_MS) {
    return countsCache.counts;
  }
  const stats = await getStats(workspace);
  const counts = { all: stats.total, text: stats.text_count, image: stats.image_count, file: stats.file_count, pinned: stats.pinned };
  countsCache = { workspace, counts, ts: Date.now() };
  return counts;
}

/** 清除计数缓存（新增/删除/切换工作区后调用，强制下次立即查后端） */
export function invalidateCountsCache() {
  countsCache = null;
  // 通知 TopBar 重新获取计数
  window.dispatchEvent(new CustomEvent("counts-invalidated"));
}

/** 图片路径转文件 URL（使用 Tauri 的 asset 协议，浏览器原生缓存） */
const imageUrlCache = new Map<string, string>();
const MAX_IMAGE_CACHE_SIZE = 20;

/** 清理图片缓存（页面卸载时调用） */
export function clearImageCaches() {
  imageUrlCache.clear();
  thumbnailUrlCache.clear();
}

/** 获取原图 URL（用于 img src 显示，使用 Tauri asset 协议） */
export async function getImageDataUrl(filePath: string): Promise<string> {
  if (imageUrlCache.has(filePath)) {
    return imageUrlCache.get(filePath)!;
  }
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(filePath);
    if (imageUrlCache.size >= MAX_IMAGE_CACHE_SIZE) {
      const firstKey = imageUrlCache.keys().next().value;
      if (firstKey) imageUrlCache.delete(firstKey);
    }
    imageUrlCache.set(filePath, url);
    return url;
  } catch (e) {
    logger.error("convertFileSrc 失败", e);
    return "";
  }
}

/** 获取图片 base64 data URL（仅用于复制到剪贴板，不用于显示） */
export async function getImageBase64(filePath: string): Promise<string> {
  try {
    return await invoke<string>("get_image_data_url", { path: filePath });
  } catch (e) {
    logger.error("读取图片 base64 失败", e);
    return "";
  }
}

/** 获取图片缩略图 URL（返回文件路径，由前端转 asset URL） */
const thumbnailUrlCache = new Map<string, string>();
const MAX_THUMBNAIL_CACHE_SIZE = 200;

export async function getImageThumbnail(filePath: string): Promise<string> {
  if (thumbnailUrlCache.has(filePath)) {
    return thumbnailUrlCache.get(filePath)!;
  }
  try {
    const thumbPath = await invoke<string>("get_image_thumbnail", { path: filePath });
    // 将本地文件路径转为 Tauri asset:// URL
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(thumbPath);
    if (thumbnailUrlCache.size >= MAX_THUMBNAIL_CACHE_SIZE) {
      const firstKey = thumbnailUrlCache.keys().next().value;
      if (firstKey) thumbnailUrlCache.delete(firstKey);
    }
    thumbnailUrlCache.set(filePath, url);
    return url;
  } catch (e) {
    logger.error("生成缩略图失败", e);
    return "";
  }
}

/** 获取图片详细信息 */
export async function getImageInfo(filePath: string): Promise<{
  width: number; height: number; file_size: number;
  size_str: string; file_name: string; path: string;
} | null> {
  try {
    return await invoke("get_image_info", { path: filePath });
  } catch (e) {
    logger.error("获取图片信息失败", e);
    return null;
  }
}

/** 获取应用版本号 */
export async function getAppVersion(): Promise<string> {
  try {
    return await invoke<string>("get_app_version");
  } catch {
    return "?.?.?";
  }
}

/** 获取应用名称 */
export async function getAppName(): Promise<string> {
  try {
    return await invoke<string>("get_app_name");
  } catch {
    return "PastePanda";
  }
}
