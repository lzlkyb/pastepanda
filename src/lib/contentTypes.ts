/**
 * 统一内容类型映射 — 唯一来源，Card/ContextMenu/EditDialog 共用。
 * content_type 由 Rust ContentClassifier 在插入时计算并持久化。
 */

export type ContentType =
  | "text" | "link" | "email" | "phone" | "color" | "file_path"
  | "code" | "json" | "markdown" | "html" | "config" | "csv"
  | "shell" | "log" | "secret" | "number" | "image" | "file";

export interface ContentTypeMeta {
  /** 中文显示标签 */
  label: string;
  /** 图标颜色 (hex) */
  color: string;
  /** 是否使用等宽字体预览 */
  monospace: boolean;
}

/** content_type → 显示元信息 */
export const CONTENT_TYPE_META: Record<ContentType, ContentTypeMeta> = {
  text:      { label: "文本",     color: "#6B7280", monospace: false },
  link:      { label: "链接",     color: "#10B981", monospace: false },
  email:     { label: "邮箱",     color: "#3B82F6", monospace: false },
  phone:     { label: "电话",     color: "#F59E0B", monospace: false },
  color:     { label: "颜色",     color: "#EC4899", monospace: false },
  file_path: { label: "路径",     color: "#06B6D4", monospace: true },
  code:      { label: "代码",     color: "#8B5CF6", monospace: true },
  json:      { label: "JSON",    color: "#F97316", monospace: true },
  markdown:  { label: "Markdown", color: "#6366F1", monospace: false },
  html:      { label: "HTML",    color: "#EF4444", monospace: true },
  config:    { label: "配置",     color: "#14B8A6", monospace: true },
  csv:       { label: "表格",     color: "#84CC16", monospace: true },
  shell:     { label: "命令",     color: "#A855F7", monospace: true },
  log:       { label: "日志",     color: "#78716C", monospace: true },
  secret:    { label: "密钥",     color: "#DC2626", monospace: true },
  number:    { label: "数字",     color: "#0EA5E9", monospace: true },
  image:     { label: "图片",     color: "#EC4899", monospace: false },
  file:      { label: "文件",     color: "#06B6D4", monospace: false },
};

/** 获取 content_type 的元信息（容错：未知类型回退到 text） */
export function getContentTypeMeta(contentType?: string): ContentTypeMeta {
  return CONTENT_TYPE_META[(contentType || "text") as ContentType] || CONTENT_TYPE_META.text;
}

/** 判断是否为代码类（用于语法高亮决策） */
export function isCodeLike(contentType?: string): boolean {
  return ["code", "json", "html", "config", "csv", "shell", "log"].includes(contentType || "");
}

/** 判断是否应遮罩显示（密钥类） */
export function isSecret(contentType?: string): boolean {
  return contentType === "secret";
}
