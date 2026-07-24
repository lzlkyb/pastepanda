import { useState, useMemo } from "react";
import DOMPurify from "dompurify";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff } from "./editorBits";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/** 预览 iframe 的基础排版（剪贴板 HTML 片段通常不带样式） */
const PREVIEW_BASE_CSS = `body{font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:13px;line-height:1.7;color:#0F172A;padding:14px 18px;margin:0;word-wrap:break-word}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #E0E4EB;padding:4px 8px}`;

/**
 * HTML 专用编辑器（P2）：默认预览模式。
 * 预览在 sandbox="" 的 iframe 中渲染（DOMPurify 双重消毒，防剪贴板内容 XSS）；
 * 编辑模式与 TextEditor 一致（shiki 高亮 + 变换工具栏 + 去标签）。
 */
export function HtmlEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  // 渲染与文本提取都基于消毒后的 HTML（script/style 已被 DOMPurify 剥离）
  const safeHtml = useMemo(() => DOMPurify.sanitize(text), [text]);
  const srcDoc = useMemo(
    () => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PREVIEW_BASE_CSS}</style></head><body>${safeHtml}</body></html>`,
    [safeHtml]
  );

  const handleCopyRendered = async () => {
    try {
      const doc = new DOMParser().parseFromString(safeHtml, "text/html");
      await navigator.clipboard.writeText(doc.body.textContent || "");
      toast("已复制渲染文本", "success");
    } catch { toast("复制失败", "error"); }
  };

  const handleCopySource = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制源码", "success");
    } catch { toast("复制失败", "error"); }
  };

  const charCount = text.length;
  const lineCount = text.split("\n").length;

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={charCount}
        isModified={isModified}
        badge="🔧 HTML"
        extra={
          <div className="md-mode-toggle">
            <button className={`md-mode-btn${mode === "edit" ? " active" : ""}`} onClick={() => setMode("edit")}>编辑</button>
            <button className={`md-mode-btn${mode === "preview" ? " active" : ""}`} onClick={() => setMode("preview")}>预览</button>
          </div>
        }
      />

      {mode === "preview" ? (
        <>
          <div className="html-preview-wrap">
            <iframe className="html-preview-frame" sandbox="" srcDoc={srcDoc} title="HTML 预览" />
          </div>
          <div className="md-preview-actions">
            <button className="md-preview-btn" onClick={handleCopyRendered}>📋 复制渲染文本</button>
            <button className="md-preview-btn" onClick={handleCopySource}>📄 复制源码</button>
          </div>
        </>
      ) : (
        <>
          <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />

          <TransformToolbar
            text={text}
            transform={(fn) => pushHistory(fn(text))}
            undo={undo}
            redo={redo}
            isModified={isModified}
            showOriginal={showOriginal}
            onToggleOriginal={() => setShowOriginal(!showOriginal)}
            isHtmlContent
          />

          {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
        </>
      )}
    </>
  );
}
