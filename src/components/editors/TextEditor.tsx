import { useState, useEffect, useMemo } from "react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff } from "./editorBits";
import { highlightCode, getLangLabel } from "@/lib/utils";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 通用文本/代码编辑器（方案 A 默认编辑器）。
 * 元信息条 + 高亮编辑区 + 文本变换工具栏 + 原文对比。
 */
export function TextEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const [langLabel, setLangLabel] = useState("检测中…");
  const isHtmlContent = useMemo(() => item?.content_type === "html", [item?.content_type]);

  // 文本变化时更新语言标签（带取消守卫：慢请求不得覆盖新内容的检测结果 — M22）
  useEffect(() => {
    if (text.length > 5000) {
      setLangLabel("文本");
      return;
    }
    let cancelled = false;
    highlightCode(text).then((r) => {
      if (!cancelled) setLangLabel(getLangLabel(r.language));
    });
    return () => { cancelled = true; };
  }, [text]);

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));
  const charCount = text.length;
  const lineCount = text.split("\n").length;

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={charCount}
        isModified={isModified}
        badge={langLabel !== "文本" && langLabel !== "检测中…" ? <>🔧 {langLabel}</> : "✏️ 编辑"}
      />

      <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />

      <TransformToolbar
        text={text}
        transform={transform}
        undo={undo}
        redo={redo}
        isModified={isModified}
        showOriginal={showOriginal}
        onToggleOriginal={() => setShowOriginal(!showOriginal)}
        isHtmlContent={isHtmlContent}
      />

      {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
    </>
  );
}
