/**
 * imageFormat — 图片导出格式与体积估算的纯逻辑模块（② 格式转换+压缩）。
 *
 * 与编辑器/预览弹窗解耦：仅描述格式元数据与体积格式化，
 * canvas 转码（toBlob）在 hook 中调用，便于单测核心逻辑。
 */

export type ExportFormat = "png" | "jpeg" | "webp";

export interface FormatMeta {
  /** canvas.toBlob / toDataURL 使用的 MIME 类型 */
  mime: string;
  /** 保存对话框默认扩展名 */
  ext: string;
  /** 界面显示标签 */
  label: string;
  /** 是否为有损压缩（决定是否显示质量滑块） */
  lossy: boolean;
}

export const EXPORT_FORMATS: Record<ExportFormat, FormatMeta> = {
  png: { mime: "image/png", ext: "png", label: "PNG", lossy: false },
  jpeg: { mime: "image/jpeg", ext: "jpg", label: "JPG", lossy: true },
  webp: { mime: "image/webp", ext: "webp", label: "WebP", lossy: true },
};

export const EXPORT_FORMAT_ORDER: ExportFormat[] = ["png", "jpeg", "webp"];

/** 默认导出质量（0-1），有损格式通用 */
export const DEFAULT_EXPORT_QUALITY = 0.85;

/** 将源文件名（可能含扩展名）替换为目标格式扩展名 */
export function withExportExt(fileName: string, format: ExportFormat): string {
  const base = fileName.replace(/\.[^.]+$/, "") || "image";
  return `${base}.${EXPORT_FORMATS[format].ext}`;
}

/**
 * 字节数格式化为人类可读字符串（B/KB/MB/GB）。
 *
 * 实现**收口在 `lib/utils.ts`**（规则 11，2026-09-22）：旧本地版封顶 MB、
 * 且把 0 与非法输入混为 `"—"`。统一后 0 → `"0 B"`（空文件是合法值）、
 * 非法（负数/NaN/±∞）→ `"—"`。两处调用方（ImagePreviewDialog /
 * useImagePreview）实际传入的都是真实字节数或已判空的估计值，行为不受影响。
 */
export { formatBytes } from "@/lib/utils";
