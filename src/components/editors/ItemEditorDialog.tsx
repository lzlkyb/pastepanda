import { useRef, useState, useCallback, useEffect, Suspense, type ComponentType } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, ClipboardPaste, Bookmark } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { resolveEditor, type EditorActions, type FooterAction, type ShellEditorDefinition, type CustomEditorProps } from "@/lib/editorRegistry";
import { ActionBtn } from "./editorBits";
import { FocusTrap } from "@/components/FocusTrap";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { HistoryItem } from "@/stores/appStore";

/**
 * 统一编辑器弹窗外壳（方案 A）。
 * shell 变体：外壳负责 遮罩 / 动画 / 焦点陷阱 / Esc / Ctrl+Enter / 未保存关闭守卫 /
 *   footer 动作按钮（可见性由 EditorDefinition.footer 静态声明），
 *   编辑器主体负责 内容状态 + 工具栏，通过 registerActions 上报能力实现。
 * customShell 变体（图片/文件）：组件自带完整弹窗，外壳仅负责挂载与关闭路由。
 */
export function ItemEditorDialog() {
  const editorItem = useDialogStore((s) => s.editorItem);
  const closeEditor = useDialogStore((s) => s.closeEditor);
  const def = editorItem ? resolveEditor(editorItem) : null;
  return (
    <AnimatePresence>
      {editorItem && def && (
        def.customShell ? (
          <CustomEditorHost key={editorItem.id} component={def.component} item={editorItem} onClose={closeEditor} />
        ) : (
          <EditorShell key={editorItem.id} def={def} item={editorItem} onClose={closeEditor} />
        )
      )}
    </AnimatePresence>
  );
}

/** customShell 变体宿主：组件自带 backdrop/header/footer，这里仅挂载（lazy + 错误隔离） */
function CustomEditorHost({ component: Comp, item, onClose }: {
  component: ComponentType<CustomEditorProps>;
  item: HistoryItem;
  onClose: () => void;
}) {
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <Comp item={item} onClose={onClose} />
      </Suspense>
    </ErrorBoundary>
  );
}

function EditorShell({ def, item, onClose }: { def: ShellEditorDefinition; item: HistoryItem; onClose: () => void }) {
  const actionsRef = useRef<EditorActions>({});
  const registerActions = useCallback((a: EditorActions) => { actionsRef.current = a; }, []);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // 关闭守卫：无修改直接关；有修改先确认，防止误触 Esc/遮罩丢失编辑
  const requestClose = useCallback(() => {
    const dirty = actionsRef.current.isDirty?.() ?? false;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [onClose]);

  const handleSave = useCallback(async () => {
    const save = actionsRef.current.save;
    if (!save || saving) return;
    setSaving(true);
    try {
      const ok = await save();
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  }, [onClose, saving]);

  // ref 转发：键盘监听器保持稳定，闭包始终新鲜
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      requestCloseRef.current();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSaveRef.current();
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // U47：打开即聚焦编辑框（Markdown 预览/未来非文本编辑器无此 id，自然跳过）
  useEffect(() => {
    const t = window.setTimeout(() => {
      document.getElementById("edit-code-textarea")?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const EditorComponent = def.component;

  const FOOTER_BTNS: Record<FooterAction, { icon: React.ReactNode; label: string; run: () => void }> = {
    copy: { icon: <Copy size={13} />, label: "复制", run: () => actionsRef.current.copy?.() },
    paste: { icon: <ClipboardPaste size={13} />, label: "粘贴", run: () => actionsRef.current.paste?.() },
    snippet: { icon: <Bookmark size={13} />, label: "存片段", run: () => actionsRef.current.addSnippet?.() },
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="dialog-backdrop" onClick={requestClose}>
        <FocusTrap>
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={`dialog-box ${def.width}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: "85vh" }}>

            {/* Header */}
            <div className="dialog-header">
              <h2 className="dialog-title">{def.title}</h2>
              <button onClick={requestClose} className="dialog-close"><X size={16} /></button>
            </div>

            {/* Body（内容完全由编辑器主体拥有） */}
            <div className="dialog-body" style={{ "--dialog-body-gap": "10px" } as React.CSSProperties}>
              <Suspense fallback={null}>
                <EditorComponent item={item} registerActions={registerActions} />
              </Suspense>
            </div>

            {/* Footer */}
            <div className="dialog-footer">
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Ctrl+Enter 保存 · Esc 取消</span>
              <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                {def.footer.map((action) => {
                  const btn = FOOTER_BTNS[action];
                  return <ActionBtn key={action} icon={btn.icon} label={btn.label} onClick={btn.run} />;
                })}
                <button className="btn-primary" onClick={handleSave} disabled={saving} style={{ padding: "5px 14px", fontSize: 12, opacity: saving ? 0.7 : 1 }}>
                  {saving ? <><span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "editSaveSpin 0.6s linear infinite", marginRight: 4, verticalAlign: "middle" }} /> 保存中…</> : "💾 保存"}
                </button>
              </div>
            </div>
          </motion.div>
        </FocusTrap>
      </motion.div>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃修改？"
        message="当前编辑尚未保存，关闭后修改将丢失。确定要放弃吗？"
        confirmText="放弃修改"
        cancelText="继续编辑"
        variant="warning"
        onConfirm={() => { setConfirmDiscard(false); onClose(); }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
}
