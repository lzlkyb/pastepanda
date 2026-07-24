import { useState } from "react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff } from "./editorBits";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * Markdown 专用编辑器（方案 A）：默认预览模式，可切换编辑。
 * 预览模式：渲染结果 + 复制为 HTML / 纯文本；
 * 编辑模式：与 TextEditor 相同的高亮编辑区 + 变换工具栏。
 */
export function MarkdownEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  // content_type 为 markdown 的条目默认进入预览模式（与旧版行为一致）
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  const handleCopyHtml = async () => {
    try {
      const { marked } = await import("marked");
      const DOMPurify = (await import("dompurify")).default;
      const html = DOMPurify.sanitize(marked.parse(text) as string);
      await navigator.clipboard.writeText(html);
      toast("已复制 HTML", "success");
    } catch { toast("复制失败", "error"); }
  };

  const handleCopyPlain = async () => {
    try {
      // 剥离 MD 语法，保留纯文本
      const plain = text
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^>\s+/gm, "")
        .replace(/^[-*+]\s+/gm, "")
        .replace(/^\d+\.\s+/gm, "");
      await navigator.clipboard.writeText(plain);
      toast("已复制纯文本", "success");
    } catch { toast("复制失败", "error"); }
  };

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));
  const charCount = text.length;
  const lineCount = text.split("\n").length;

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={charCount}
        isModified={isModified}
        badge="📝 Markdown"
        extra={
          <div className="md-mode-toggle">
            <button className={`md-mode-btn${mode === "edit" ? " active" : ""}`} onClick={() => setMode("edit")}>编辑</button>
            <button className={`md-mode-btn${mode === "preview" ? " active" : ""}`} onClick={() => setMode("preview")}>预览</button>
          </div>
        }
      />

      {mode === "preview" ? (
        <>
          <div className="md-preview-wrap">
            <MarkdownRenderer text={text} />
          </div>
          <div className="md-preview-actions">
            <button className="md-preview-btn" onClick={handleCopyHtml}>📋 复制为 HTML</button>
            <button className="md-preview-btn" onClick={handleCopyPlain}>📄 复制为纯文本</button>
          </div>
        </>
      ) : (
        <>
          <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />

          <TransformToolbar
            text={text}
            transform={transform}
            undo={undo}
            redo={redo}
            isModified={isModified}
            showOriginal={showOriginal}
            onToggleOriginal={() => setShowOriginal(!showOriginal)}
            isHtmlContent={false}
          />

          {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
        </>
      )}
    </>
  );
}
