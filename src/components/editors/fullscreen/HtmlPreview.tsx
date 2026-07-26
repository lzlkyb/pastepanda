/**
 * HTML 类型专属预览：sandbox iframe 沙箱渲染（DOMPurify 双重消毒，防剪贴板 XSS）。
 * 与 HtmlEditor 小弹窗的预览逻辑一致。
 */
import { useMemo } from "react";
import DOMPurify from "dompurify";
import styles from "../FullscreenEditor.module.css";

/** 预览 iframe 基础排版（剪贴板 HTML 片段通常不带样式） */
const PREVIEW_BASE_CSS = `body{font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:13px;line-height:1.7;color:#0F172A;padding:14px 18px;margin:0;word-wrap:break-word}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #E0E4EB;padding:4px 8px}`;

export function HtmlPreview({ text }: { text: string }) {
  // 渲染基于消毒后的 HTML（script/style 已被 DOMPurify 剥离）
  const safeHtml = useMemo(() => DOMPurify.sanitize(text), [text]);
  const srcDoc = useMemo(
    () =>
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PREVIEW_BASE_CSS}</style></head><body>${safeHtml}</body></html>`,
    [safeHtml]
  );

  return <iframe className={styles.htmlPreviewFrame} sandbox="" srcDoc={srcDoc} title="HTML 预览" />;
}
