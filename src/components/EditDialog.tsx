import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, ClipboardPaste, Bookmark, Type, Scissors, Quote, AlignLeft, CaseSensitive, Undo2, Redo2, ChevronDown, ChevronUp } from "lucide-react";
import Editor from "react-simple-code-editor";
import { useToast } from "@/components/Toast";
import { pasteText } from "@/lib/api";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { highlightCode, getLangLabel } from "@/lib/utils";

// 高亮函数：接受代码字符串，返回 React 节点
async function highlightFn(code: string): Promise<React.ReactNode> {
  if (!code) return "";
  if (code.length > 5000) return code;
  try {
    const r = await highlightCode(code);
    // 如果无高亮结果（纯文本），返回原始文本，确保可见
    if (!r.html) return code;
    // 包装 shiki class 让 CSS 变量切换生效
    return <span className="shiki" dangerouslySetInnerHTML={{ __html: r.html }} />;
  } catch {
    return code;
  }
}

// 同步高亮包装器（用缓存避免闪烁）
function useHighlight(code: string) {
  const [highlighted, setHighlighted] = useState<React.ReactNode>(code);
  useEffect(() => {
    let cancelled = false;
    highlightFn(code).then(r => {
      if (!cancelled) setHighlighted(r);
    });
    return () => { cancelled = true; };
  }, [code]);
  return highlighted;
}

export function EditDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const [text, setText] = useState(item?.text || "");
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();
  const originalText = item?.text || "";
  const [langLabel, setLangLabel] = useState("检测中…");

  // 初始化语言检测
  useEffect(() => {
    highlightCode(item?.text || "").then(r => {
      setLangLabel(getLangLabel(r.language));
    });
  }, []);

  // 文本变化时更新语言标签
  useEffect(() => {
    if (text.length <= 5000) {
      highlightCode(text).then(r => {
        setLangLabel(getLangLabel(r.language));
      });
    } else {
      setLangLabel("文本");
    }
  }, [text]);

  // 撤销/重做历史（纯文本级别）
  const historyRef = useRef<string[]>([item?.text || ""]);
  const historyIdxRef = useRef(0);

  const pushHistory = useCallback((newText: string) => {
    const stack = historyRef.current;
    const idx = historyIdxRef.current;
    const newStack = stack.slice(0, idx + 1);
    newStack.push(newText);
    if (newStack.length > 30) newStack.shift();
    historyRef.current = newStack;
    historyIdxRef.current = newStack.length - 1;
    setText(newText);
  }, []);

  const undo = useCallback(() => {
    if (historyIdxRef.current > 0) {
      historyIdxRef.current--;
      setText(historyRef.current[historyIdxRef.current]);
    }
  }, []);

  const redo = useCallback(() => {
    if (historyIdxRef.current < historyRef.current.length - 1) {
      historyIdxRef.current++;
      setText(historyRef.current[historyIdxRef.current]);
    }
  }, []);

  const handleSaveRef = useRef<() => void>(() => {});

  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      await handleSaveRef.current();
    }
  }, [onClose]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleSave = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_history", { id: item.id, text });
      const store = useAppStore.getState();
      store.setHistory(store.history.map(h =>
        h.id === item.id
          ? { ...h, text, md5: undefined }
          : h
      ));
      invoke<HistoryItem[]>("get_history", {
        workspace: store.config.current_workspace, filter: "all",
        search: "", offset: 0, limit: 200
      }).then(items => {
        const backendMap = new Map(items.map(i => [i.id, i]));
        store.setHistory(store.history.map(h => backendMap.get(h.id) || h));
      }).catch(() => {});
      toast("已保存", "success");
      onClose();
    } catch (e) {
      toast("保存失败: " + (e instanceof Error ? e.message : String(e)), "error");
    }
  };
  handleSaveRef.current = handleSave;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板", "success");
    } catch { toast("复制失败", "error"); }
  };

  const handlePaste = async () => {
    try {
      await pasteText(text);
      toast("已粘贴", "success");
    } catch { toast("粘贴失败", "error"); }
  };

  const handleAddSnippet = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("add_snippet", { name: text.slice(0, 30), content: text });
      toast("已添加到片段库", "success");
    } catch { toast("添加失败", "error"); }
  };

  // 文本变换
  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  // 语法高亮
  const highlighted = useHighlight(text);

  const charCount = text.length;
  const lineCount = text.split("\n").length;
  const isModified = text !== originalText;

  if (!item) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="dialog-backdrop" onClick={onClose}>
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 10 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="dialog-box w500"
          onClick={(e) => e.stopPropagation()}
          style={{ maxHeight: "85vh" }}>

          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title">✏️ 编辑记录</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          {/* Body */}
          <div className="dialog-body" style={{ "--dialog-body-gap": "10px" } as React.CSSProperties}>
            {/* 元信息条 */}
            <div className="code-meta-bar">
              <div className="code-meta-left">
                <div className="code-meta-item"><span className="code-meta-label">行</span><span className="code-meta-val">{lineCount}</span></div>
                <div className="code-meta-item"><span className="code-meta-label">字符</span><span className="code-meta-val">{charCount}</span></div>
                {isModified && <div className="code-meta-item" style={{ color: "var(--accent)" }}><span className="code-meta-label">状态</span><span className="code-meta-val">已修改</span></div>}
              </div>
              <div className="code-type-badge">
                {langLabel !== "文本" && langLabel !== "检测中…" ? <>🔧 {langLabel}</> : "✏️ 编辑"}
              </div>
            </div>

            {/* 带行号 + 语法高亮的可编辑区（textarea+pre 叠加层） */}
            <div className="edit-code-area">
              <div className="code-lines">
                {text.split("\n").map((_, i) => <span key={i} className="code-ln">{i + 1}</span>)}
              </div>
              <div className="edit-highlight-wrapper">
                <Editor
                  value={text}
                  onValueChange={(newVal) => {
                    pushHistory(newVal);
                  }}
                  highlight={(_code: string) => highlighted}
                  padding={0}
                  className="edit-highlight-editor"
                  textareaId="edit-code-textarea"
                  style={{
                    fontFamily: "'SF Mono', Consolas, monospace",
                    fontSize: 13,
                    lineHeight: 1.7,
                  }}
                />
              </div>
            </div>

            {/* 文本变换工具栏 */}
            <div className="edit-toolbar">
              <ToolBtn icon={<CaseSensitive size={13} />} label="大写" onClick={() => transform(s => s.toUpperCase())} />
              <ToolBtn icon={<Type size={13} />} label="小写" onClick={() => transform(s => s.toLowerCase())} />
              <ToolBtn icon={<Scissors size={13} />} label="去空白" onClick={() => transform(s => s.trim())} />
              <ToolBtn icon={<AlignLeft size={13} />} label="去空行" onClick={() => transform(s => s.split("\n").filter(l => l.trim()).join("\n"))} />
              <ToolBtn icon={<Quote size={13} />} label="加引号" onClick={() => transform(s => `"${s}"`)} />
              <div className="tool-separator"></div>
              <ToolBtn icon={<Undo2 size={13} />} label="撤销" onClick={undo} />
              <ToolBtn icon={<Redo2 size={13} />} label="重做" onClick={redo} />
              {isModified && (
                <button
                  onClick={() => setShowOriginal(!showOriginal)}
                  style={{
                    marginLeft: "auto", fontSize: 11, color: "var(--accent)", background: "none",
                    border: "none", cursor: "pointer", fontFamily: "inherit",
                  }}>
                  {showOriginal ? <><ChevronUp size={12} style={{verticalAlign:"middle"}} /> 隐藏原文</> : <>对比原文 <ChevronDown size={12} style={{verticalAlign:"middle"}} /></>}
                </button>
              )}
            </div>

            {/* 原文对比区 */}
            {showOriginal && isModified && (
              <div style={{
                padding: 10, borderRadius: 8, background: "var(--section-bg)",
                border: "1px solid var(--border-color)", fontSize: 12,
                color: "var(--text-secondary)", fontFamily: "'SF Mono', Consolas, monospace",
                maxHeight: 100, overflow: "auto", lineHeight: 1.5, whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>原文：</span>
                {originalText}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="dialog-footer">
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Ctrl+Enter 保存 · Esc 取消</span>
            <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
              <ActionBtn icon={<Copy size={13} />} label="复制" onClick={handleCopy} />
              <ActionBtn icon={<ClipboardPaste size={13} />} label="粘贴" onClick={handlePaste} />
              <ActionBtn icon={<Bookmark size={13} />} label="存片段" onClick={handleAddSnippet} />
              <button className="btn-primary" onClick={handleSave} style={{ padding: "5px 14px", fontSize: 12 }}>
                💾 保存
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function ToolBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6,
      border: "1px solid var(--border-color)", background: "var(--card-bg)",
      color: "var(--text-secondary)", fontSize: 11, fontWeight: 600, cursor: "pointer",
      fontFamily: "inherit", transition: "all 0.15s",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.color = "var(--text-secondary)"; }}>
      {icon}{label}
    </button>
  );
}

function ActionBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6,
      border: "1px solid var(--border-color)", background: "var(--card-bg)",
      color: "var(--text-secondary)", fontSize: 11, fontWeight: 600, cursor: "pointer",
      fontFamily: "inherit", transition: "all 0.15s",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-light)"; e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--card-bg)"; e.currentTarget.style.color = "var(--text-secondary)"; e.currentTarget.style.borderColor = "var(--border-color)"; }}>
      {icon}{label}
    </button>
  );
}
