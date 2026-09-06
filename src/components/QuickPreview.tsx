import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, ClipboardPaste, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { pasteTextGuarded } from "@/lib/api";
import { highlightCode, getLangLabel } from "@/lib/utils";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useDialogEscape } from "@/hooks/useDialogEscape";

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
  // 预览来源条目的身份（粘贴信号回写用）。事件只带 text 时为 null，此时不回写。
  const [srcItem, setSrcItem] = useState<
    { id: string; type: string; content_type?: string | null; source: string } | null
  >(null);
  const { toast } = useToast();
  const anim = useDialogAnim();

  // Esc 关预览（公共 hook：捕获期 + stopPropagation）。
  const hide = useCallback(() => setVisible(false), []);
  useDialogEscape(hide, visible);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.text) {
        setText(detail.text);
        setSrcItem(detail.item ?? null);
        setVisible(true);
      }
    };
    window.addEventListener("app-quick-preview", handler);
    // 按 Space 或 Esc 关闭
    // ❗ 只留空格：Esc 已抽到下面的 `useDialogEscape`（捕获期 + stopPropagation）。
    //   两个键原先混在这个冒泡监听里，不阻断，按 Esc 关预览的同时
    //   App 的 Esc 链会接着清多选、甚至隐藏主窗口。
    const keyHandler = (e: KeyboardEvent) => {
      if (visible && e.key === " ") {
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
    const ok = await pasteTextGuarded(text);
    if (ok) {
      toast("已粘贴", "success");
      // 粘贴信号回写（此前漏记）。快速预览没有列表位置，下标传 -1。
      if (srcItem) {
        const { logItemPasted } = await import("@/lib/api/actionEvents");
        logItemPasted(srcItem, -1);
      }
    }
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
