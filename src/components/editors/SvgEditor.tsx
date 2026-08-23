import { useState, useMemo } from "react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff } from "./editorBits";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 预览 iframe 的内容安全策略。
 *
 * `sandbox=""` 只挡脚本执行，**不挡子资源加载** —— 一段带
 * `<image href="https://tracker/x.png">` 或 `<use href>` / CSS `@import` 的 SVG，
 * 一进预览就会静默发出外网请求（剪贴板内容变成追踪像素）。对本地优先的定位来说
 * 那是隐私泄漏，所以这里再加一道 CSP：默认全禁，只放开内联样式与 data: 图片。
 */
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** 预览 iframe 的排版：棋盘格底（透明 SVG 可辨识）+ 居中 + 自适应 */
const PREVIEW_CSS = `html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#EEF2F6 0% 25%, #FFFFFF 0% 50%) 0 0 / 18px 18px}svg{max-width:96vw;max-height:96vh}`;

/**
 * SVG 专用编辑器（Tier2）：编辑 / 预览 双模式（镜像 HtmlEditor 范式）。
 * 路由：resolveEditor 对 code/html/text 中 isSvgLike 的内容特判进来（分类器从不产出 svg 类型）。
 * 校验：DOMParser(image/svg+xml) 查 parsererror；预览在 sandbox="" iframe 中渲染（脚本不执行）。
 */
export function SvgEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  const valid = useMemo(() => {
    const t = text.trim();
    if (!t) return false;
    try {
      const doc = new DOMParser().parseFromString(t, "image/svg+xml");
      return !doc.querySelector("parsererror");
    } catch {
      return false;
    }
  }, [text]);

  const srcDoc = useMemo(() => {
    if (!valid) return "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>${PREVIEW_CSS}</style></head><body>${text}</body></html>`;
  }, [text, valid]);

  const handleCopySource = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制源码", "success");
    } catch { toast("复制失败", "error"); }
  };

  return (
    <>
      <MetaBar
        lineCount={text.split("\n").length}
        charCount={text.length}
        isModified={isModified}
        badge="🖼 SVG"
        status={
          valid ? (
            <span className="json-valid-badge">✓ 有效 SVG</span>
          ) : (
            <span className="json-invalid-badge">✕ 无法解析为 SVG</span>
          )
        }
        extra={
          <div className="md-mode-toggle">
            <button className={`md-mode-btn${mode === "edit" ? " active" : ""}`} onClick={() => setMode("edit")}>编辑</button>
            <button className={`md-mode-btn${mode === "preview" ? " active" : ""}`} onClick={() => setMode("preview")}>预览</button>
          </div>
        }
      />

      {mode === "preview" ? (
        <>
          <div className="svg-preview-wrap">
            {valid ? (
              <iframe className="svg-preview-frame" sandbox="" srcDoc={srcDoc} title="SVG 预览" />
            ) : (
              <div className="svg-preview-error">不是合法 SVG，请切到「编辑」修正源码</div>
            )}
          </div>
          <div className="md-preview-actions">
            <button className="md-preview-btn" onClick={handleCopySource}>📋 复制源码</button>
            <button className="md-preview-btn" onClick={() => setMode("edit")}>✏️ 切到编辑</button>
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
