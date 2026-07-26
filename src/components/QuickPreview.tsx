import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, ClipboardPaste, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { pasteText } from "@/lib/api";
import { highlightCode, getLangLabel } from "@/lib/utils";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";

/**
 * 快速预览面板 — 按 Space 键弹出，显示选中文本的完整内容
 * 监听全局 `app-quick-preview` 事件，自动检测语言并高亮代码
 */
export function QuickPreview() {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState("");
  const [highlightedHtml, setHighlightedHtml] = useState("");
  const [langInfo, setLangInfo] = useState<{ name: string; label: string }>({ name: "plain", label: "文本" });
  const [highlighting, setHighlighting] = useState(false);
  const { toast } = useToast();
  const anim = useDialogAnim();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.text) {
        setText(detail.text);
        setVisible(true);
      }
    };
    window.addEventListener("app-quick-preview", handler);
    // 按 Space 或 Esc 关闭
    const keyHandler = (e: KeyboardEvent) => {
      if (visible && (e.key === "Escape" || e.key === " ")) {
        e.preventDefault();
        setVisible(false);
      }
    };
    window.addEventListener("keydown", keyHandler);
    return () => {
      window.removeEventListener("app-quick-preview", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [visible]);

  // 文本变化时高亮（带取消守卫：慢请求不得覆盖新内容 — M22）
  useEffect(() => {
    if (!text || !visible) return;

    if (text.length <= 5000) {
      let cancelled = false;
      setHighlighting(true);
      highlightCode(text).then((result) => {
        if (cancelled) return;
        setHighlightedHtml(result.html);
        setLangInfo({ name: result.language, label: getLangLabel(result.language) });
        setHighlighting(false);
      });
      return () => { cancelled = true; };
    } else {
      setHighlightedHtml("");
      setLangInfo({ name: "plain", label: "文本" });
      setHighlighting(false);
    }
  }, [text, visible]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板", "success");
    } catch { toast("复制失败", "error"); }
  }, [text, toast]);

  const handlePaste = async () => {
    // U1：仅粘贴成功时弹成功提示（pasteText 失败时已自行弹错误 toast）
    const ok = await pasteText(text);
    if (ok) toast("已粘贴", "success");
  };

  const lineCount = text.split("\n").length;
  const charCount = text.length;
  const lines = text.split("\n");

  const langLabel = langInfo.name !== "plain" ? langInfo.label : "文本";
  const langIcon = langInfo.name !== "plain" ? "📝" : "📄";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop z-modal-top"
          onClick={() => setVisible(false)}
        >
          <FocusTrap>
          <motion.div
            {...anim.panel}
            className="dialog-box w380"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="dialog-header">
              <h2 className="dialog-title">📄 快速预览</h2>
              <button onClick={() => setVisible(false)} className="dialog-close"><X size={16} /></button>
            </div>

            {/* Body */}
            <div className="dialog-body" style={{ "--dialog-body-gap": "10px" } as React.CSSProperties}>
              {/* 元信息条 */}
              <div className="code-meta-bar">
                <div className="code-meta-left">
                  <div className="code-meta-item"><span className="code-meta-label">行</span><span className="code-meta-val">{lineCount}</span></div>
                  <div className="code-meta-item"><span className="code-meta-label">字符</span><span className="code-meta-val">{charCount}</span></div>
                </div>
                <div className="code-type-badge">
                  {highlighting ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <Loader2 size={11} className="spin-icon" /> 高亮中
                    </span>
                  ) : (
                    <>{langIcon} {langLabel}</>
                  )}
                </div>
              </div>

              {/* 带行号的代码查看器 */}
              <div className="code-viewer">
                <div className="code-lines">
                  {lines.map((_, i) => <span key={i} className="code-ln">{i + 1}</span>)}
                </div>
                {highlightedHtml ? (
                  <pre className="code-text code-highlighted shiki">
                    <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
                  </pre>
                ) : (
                  <pre className="code-text">{text}</pre>
                )}
              </div>

              {/* 操作栏 */}
              <div className="code-actions-bar">
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Space / Esc 关闭 · 可选中文本</span>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button onClick={handleCopy} className="btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }}>
                    <Copy size={12} /> 复制
                  </button>
                  <button onClick={handlePaste} className="btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }}>
                    <ClipboardPaste size={12} /> 粘贴
                  </button>
                </div>
              </div>
            </div>

          </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
