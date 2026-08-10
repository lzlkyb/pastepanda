import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, AlertTriangle } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  variant = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const anim = useDialogAnim();
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop z-confirm"
          onClick={onCancel}
        >
          <FocusTrap>
          <motion.div
            {...anim.panel}
            className="dialog-box w400"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="dialog-header">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <AlertTriangle size={16} style={{ color: variant === "danger" ? "var(--danger, #EF4444)" : "var(--warning, #F59E0B)" }} />
                <h2 className="dialog-title">{title}</h2>
              </div>
              <button onClick={onCancel} className="dialog-close"><X size={16} /></button>
            </div>

            {/* Body */}
            <div className="dialog-body" style={{ "--dialog-body-gap": "12px" } as React.CSSProperties}>
              {/* pre-line：让调用方能用 \n 把“将写入哪些文件”这类清单分行列出。
                  现有调用方的 message 均为单行模板串，不会因此多出换行。*/}
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, whiteSpace: "pre-line" }}>
                {message}
              </p>
            </div>

            {/* Footer */}
            <div className="dialog-footer" style={{ justifyContent: "flex-end" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-secondary" onClick={onCancel} autoFocus>
                  {cancelText}
                </button>
                <button
                  className={variant === "danger" ? "btn-danger" : "btn-primary"}
                  onClick={() => { onConfirm(); }}
                >
                  {confirmText}
                </button>
              </div>
            </div>
          </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
