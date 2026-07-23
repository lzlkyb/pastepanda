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
