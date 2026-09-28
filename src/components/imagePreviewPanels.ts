/**
 * 共享类型：图片全屏查看层的浮出面板 id。
 * 互斥收口在 useImagePreview 的 activePanel（同时最多一个面板）。
 */
export type PanelId = "ocr" | "export" | "codes" | null;
