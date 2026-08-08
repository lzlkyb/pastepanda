/**
 * 图片 API — 图片 URL 获取、base64、缩略图、信息
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { getImageUrlCache, getMaxImageCacheSize, getThumbnailUrlCache, getMaxThumbnailCacheSize } from "./cache";

/** OCR 识别出的一个词（带坐标框，用于框选） */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

export interface OcrResult {
  lines: OcrLine[];
  fullText: string;
}

/**
 * 对图片文件做本地 OCR（Windows OCR 引擎）。
 *
 * **完全本地**：不联网、不花钱、图片不出机器。它与 AI 总开关无关，
 * 关掉 AI 也能用——只是识别完之后没有云端动作可选。
 */
export async function ocrImage(path: string): Promise<OcrResult> {
  return invoke<OcrResult>("ocr_image", { path });
}

/** 获取原图 URL（用于 img src 显示，使用 Tauri asset 协议） */
export async function getImageDataUrl(filePath: string): Promise<string> {
  const imageUrlCache = getImageUrlCache();
  if (imageUrlCache.has(filePath)) {
    return imageUrlCache.get(filePath)!;
  }
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(filePath);
    if (imageUrlCache.size >= getMaxImageCacheSize()) {
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
export async function getImageThumbnail(filePath: string): Promise<string> {
  const thumbnailUrlCache = getThumbnailUrlCache();
  if (thumbnailUrlCache.has(filePath)) {
    return thumbnailUrlCache.get(filePath)!;
  }
  try {
    const thumbPath = await invoke<string>("get_image_thumbnail", { path: filePath });
    // 将本地文件路径转为 Tauri asset:// URL
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(thumbPath);
    if (thumbnailUrlCache.size >= getMaxThumbnailCacheSize()) {
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
