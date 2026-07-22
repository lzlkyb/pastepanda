import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, HistoryItem, Group, Tag } from "@/stores/appStore";
import { logger } from "@/lib/logger";

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
    const groups = await invoke<Group[]>("get_groups");
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
        const msg = isLanSync ? `📡 ${event.payload.item.source.replace("局域网: ", "")}同步了${typeLabel}` : `已记录${typeLabel}`;
        window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: msg, type: isLanSync ? "info" : "success" } }));
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

    // 监听依次粘贴热键 (Ctrl+Q)
    unlistens.push(await listen("hotkey-sequential-paste", async () => {
      console.log("[hotkey-sequential-paste] 事件收到，调用 sequentialPaste()");
      await sequentialPaste();
    }));

    // 监听索引粘贴热键 (Ctrl+Alt+1~9)
    unlistens.push(await listen<number>("hotkey-index-paste", async (event) => {
      await indexPaste(event.payload);
    }));

    // 监听剪贴板栈热键 (Ctrl+Shift+K 切换 / Ctrl+Shift+P 粘贴)
    unlistens.push(await listen("hotkey-stack-toggle", () => {
      toggleStackMode();
    }));
    unlistens.push(await listen("hotkey-stack-paste", async () => {
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

/** 依次粘贴互斥锁：防止快速连按导致同一条被粘贴两次 */
let seqPasteBusy = false;

/** 依次粘贴：粘贴当前指针指向的文本，然后指针+1 */
export async function sequentialPaste() {
  const store = useAppStore.getState();
  // 栈模式与依次粘贴互斥：栈模式下请用栈粘贴热键
  if (store.stackMode) {
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式进行中，请用栈粘贴快捷键", type: "info" } }));
    return;
  }
  if (seqPasteBusy) return; // 并发重入跳过，避免粘贴同一条
  seqPasteBusy = true;
  try {
    await sequentialPasteInner();
  } finally {
    seqPasteBusy = false;
  }
}

async function sequentialPasteInner() {
  const store = useAppStore.getState();
  // 修复 Low：使用与 UI 一致的过滤后列表（原用未过滤 history，筛选/搜索激活时顺序与界面不符）
  const textItems = store.getFilteredItems().filter((h) => h.type === "text");
  const pointer = store.seqPointer;
  const loop = store.config.sequential_loop;

  logger.info(`[sequentialPaste] 触发 — textItems=${textItems.length}, pointer=${pointer}, loop=${loop}`);

  if (textItems.length === 0) {
    logger.warn("[sequentialPaste] 没有文本记录，跳过");
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "没有可粘贴的文本记录", type: "info" } }));
    return;
  }

  let idx = pointer;
  // 指针越界：循环模式下从头开始，非循环模式下提示并停止
  if (idx >= textItems.length) {
    if (loop) {
      logger.warn(`[sequentialPaste] 指针越界 ${idx} >= ${textItems.length}，循环模式：重置为 0`);
      idx = 0;
      store.setSeqPointer(0);
    } else {
      // 修复 Low：非循环模式到末尾不再静默 return，给出明确反馈
      logger.warn(`[sequentialPaste] 指针越界 ${idx} >= ${textItems.length}，非循环模式：停止`);
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已到最后一条，无更多可粘贴记录", type: "info" } }));
      return;
    }
  }

  const item = textItems[idx];
  if (!item) {
    logger.error(`[sequentialPaste] textItems[${idx}] 为 null/undefined`);
    return;
  }

  logger.info(`[sequentialPaste] 粘贴第 ${idx + 1}/${textItems.length} 条: ${item.text.slice(0, 30)}...`);

  // 调用后端粘贴引擎，成功后推进指针，失败不推进
  const ok = await pasteText(item.text);
  if (!ok) {
    logger.warn(`[sequentialPaste] 粘贴失败，指针保持 ${idx}`);
    return; // 粘贴失败不推进指针
  }

  // Toast 反馈
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴第 ${idx + 1} 条`, type: "success" } }));

  // 推进指针
  const next = idx + 1;
  if (next >= textItems.length) {
    if (loop) {
      store.setSeqPointer(0);
      logger.info("[sequentialPaste] 循环模式：指针重置为 0");
    } else {
      store.setSeqPointer(next);
      logger.info(`[sequentialPaste] 非循环模式：指针到达末尾 ${next}`);
    }
  } else {
    store.setSeqPointer(next);
  }
}

/** 索引粘贴：粘贴第 N 条文本记录 (1-based) */
export async function indexPaste(n: number) {
  const store = useAppStore.getState();
  // 修复 Low：与 UI 一致，基于过滤后列表定位第 N 条
  const textItems = store.getFilteredItems().filter((h) => h.type === "text");
  const idx = n - 1; // 转为 0-based

  if (idx < 0 || idx >= textItems.length) return;

  const item = textItems[idx];
  if (!item) return;

  await pasteText(item.text);
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴第 ${n} 条`, type: "success" } }));
}

// ===== 剪贴板栈 =====

/** 同步栈模式状态到后端（托盘图标） */
function syncStackModeToBackend(active: boolean) {
  invoke("set_stack_mode", { active }).catch((e) => logger.warn("同步栈模式到后端失败", e));
}

/** 切换栈模式 */
export function toggleStackMode() {
  const store = useAppStore.getState();
  const active = !store.stackMode;
  if (active) {
    store.setStackMode(true);
    syncStackModeToBackend(true);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式已开启 · Ctrl+C 收集 · Ctrl+Shift+P 粘贴", type: "info" } }));
  } else {
    store.exitStackMode();
    syncStackModeToBackend(false);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式已退出", type: "info" } }));
  }
}

/** 退出栈模式（手动退出，保留历史记录） */
export function exitStack() {
  useAppStore.getState().exitStackMode();
  syncStackModeToBackend(false);
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式已退出", type: "info" } }));
}

/** 栈粘贴互斥锁：防止快速连按/全部粘贴与手动粘贴并发导致重复粘贴或跳过条目 */
let stackPasteBusy = false;
let stackPasteAllRunning = false;

/** 栈粘贴：粘贴栈顶条目并弹出，栈空自动退出 */
export async function stackPasteNext(): Promise<boolean> {
  if (stackPasteBusy) return false; // 并发重入直接跳过，避免重复粘贴同一条
  stackPasteBusy = true;
  try {
    const store = useAppStore.getState();
    if (!store.stackMode) return false;

    const item = store.stackItems[0];
    if (!item) {
      // 栈空 → 自动退出
      store.exitStackMode();
      syncStackModeToBackend(false);
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈已清空，自动退出栈模式", type: "success" } }));
      return false;
    }

    let ok: boolean;
    if (item.type === "image" && item.content) {
      ok = await pasteImage(item.content);
    } else if (item.type === "file") {
      // 文件粘贴完整路径（content），与列表回车粘贴行为保持一致
      ok = await pasteText(item.content || item.text);
    } else {
      ok = await pasteText(item.text);
    }

    if (!ok) return false;

    store.stackMarkPasted();
    const remaining = useAppStore.getState().stackItems.length;
    if (remaining === 0) {
      // 全部粘贴完毕 → 自动退出
      useAppStore.getState().exitStackMode();
      syncStackModeToBackend(false);
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "全部粘贴完毕，已退出栈模式", type: "success" } }));
    } else {
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴，剩余 ${remaining} 条`, type: "success" } }));
    }
    return true;
  } finally {
    stackPasteBusy = false;
  }
}

/** 全部粘贴：间隔 300ms 连续粘贴剩余全部条目 */
export async function stackPasteAll() {
  if (stackPasteAllRunning) return; // 防止双击「全部粘贴」启动两个循环
  const store = useAppStore.getState();
  if (!store.stackMode || store.stackItems.length === 0) return;
  stackPasteAllRunning = true;
  try {
    while (useAppStore.getState().stackMode && useAppStore.getState().stackItems.length > 0) {
      const ok = await stackPasteNext();
      if (!ok) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    stackPasteAllRunning = false;
  }
}

/** 粘贴文本，返回是否成功 */
export async function pasteText(text: string): Promise<boolean> {
  try {
    const result = await invoke<{ success: boolean; error?: string; target_hwnd: number | null; clipboard_written: boolean; wm_paste_sent: boolean } | null>("paste_text", { text });
    if (!result || !result.success) {
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `粘贴失败: ${result?.error || "未知"}`, type: "error" } }));
      return false;
    }
    return true;
  } catch (e) {
    logger.error("粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `粘贴失败: ${msg}`, type: "error" } }));
    return false;
  }
}

/** 粘贴图片，返回是否成功 */
export async function pasteImage(imagePath: string): Promise<boolean> {
  try {
    await invoke("paste_image", { imagePath });
    return true;
  } catch (e) {
    logger.error("图片粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `图片粘贴失败: ${msg}`, type: "error" } }));
    return false;
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
    // 使用后端返回的权威 pinned 值直接设置，而非盲目本地取反（本地/后端状态可能因局域网同步等原因已经漂移）
    store.setPinned(id, pinned);
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

/** 将 base64 data URL 转为 Blob。
 * 修复 Low：用 fetch(dataUrl) 让浏览器网络栈原生解码 base64，
 * 替代主线程 atob + 逐字节 charCodeAt 循环（大图会阻塞数百毫秒）。 */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.type) return blob;
  // 兜底：data URL 缺 MIME 时手动指定（正常路径不会触发）
  const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
  return new Blob([blob], { type: mimeMatch ? mimeMatch[1] : "image/png" });
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

// ===== 分组 API =====

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
    return 0;
  }
}

// ===== 标签 API =====

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
