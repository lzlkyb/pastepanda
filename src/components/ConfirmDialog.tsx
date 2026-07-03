import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, AlertTriangle } from "lucide-react";

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
  if (!open) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="dialog-backdrop"
          style={{ zIndex: 100000 }}
          onClick={onCancel}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
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
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
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
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
