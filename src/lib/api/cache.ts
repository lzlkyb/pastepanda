/**
 * 缓存管理 — Tab 计数缓存 + 图片 URL 缓存
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

// ===== Tab 计数缓存（30 秒过期，按工作区分） =====

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

let countsCache: { workspace: string; counts: { all: number; text: number; image: number; file: number; pinned: number }; ts: number } | null = null;
const COUNTS_CACHE_MS = 30_000;

/** 获取统计数据 */
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

/** 按天计数条目（近 7 天趋势图） */
export interface DailyCount {
  date: string;
  count: number;
}

/** 设置页「数据仪表盘」详细统计（与 Rust StatsDetail 一一对应） */
export interface StatsDetail {
  total: number;
  pinned: number;
  today: number;
  yesterday: number;
  /** 近 7 天（含今天）升序，缺日补 0 */
  daily: DailyCount[];
  /** 0-23 时段复制计数（恒 24 槽） */
  hours: number[];
  text_count: number;
  image_count: number;
  file_count: number;
  /** 来源 Top 5（按计数降序） */
  sources: { source: string; count: number; source_icon: string | null }[];
  earliest_time: string | null;
  db_size_kb: number;
}

/** 获取详细统计（数据仪表盘）；失败返回 null，调用方保持加载态 */
export async function getStatsDetail(workspace: string): Promise<StatsDetail | null> {
  try {
    return await invoke<StatsDetail>("get_stats_detail", { workspace });
  } catch (e) {
    logger.error("获取详细统计失败", e);
    return null;
  }
}

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

// ===== 侧边栏聚合计数（后端 GROUP BY 全量统计） =====

export interface SidebarCounts {
  total: number;
  pinned: number;
  ungrouped: number;
  sources: { source: string; count: number; source_icon: string | null }[];
  /** group_id → 记录数 */
  groups: Record<string, number>;
  /** tag_id → 记录数 */
  tags: Record<string, number>;
}

/**
 * 获取侧边栏聚合计数。
 * 侧边栏此前 filter 内存分页窗口（初始 50 条、上限 500 条）计算计数，
 * 导致数字随滚动变化、未加载的来源/分类不显示；改为后端精确统计。
 * 不做本地缓存：调用方挂在 counts-invalidated 事件上（每次增删后触发），
 * SQL 为索引列上的 GROUP BY，开销与 TopBar 的 get_stats 同量级。
 */
export async function fetchSidebarCounts(workspace: string): Promise<SidebarCounts> {
  return await invoke<SidebarCounts>("get_sidebar_counts", { workspace });
}

// ===== 图片 URL 缓存（FIFO 淘汰） =====

const imageUrlCache = new Map<string, string>();
const MAX_IMAGE_CACHE_SIZE = 20;

const thumbnailUrlCache = new Map<string, string>();
const MAX_THUMBNAIL_CACHE_SIZE = 200;

/** 清理图片缓存（页面卸载时调用） */
export function clearImageCaches() {
  imageUrlCache.clear();
  thumbnailUrlCache.clear();
}

/** 获取原图 URL 缓存（内部使用） */
export function getImageUrlCache(): Map<string, string> {
  return imageUrlCache;
}

export function getMaxImageCacheSize(): number {
  return MAX_IMAGE_CACHE_SIZE;
}

/** 获取缩略图 URL 缓存（内部使用） */
export function getThumbnailUrlCache(): Map<string, string> {
  return thumbnailUrlCache;
}

export function getMaxThumbnailCacheSize(): number {
  return MAX_THUMBNAIL_CACHE_SIZE;
}
