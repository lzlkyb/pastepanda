import { useEffect } from "react";
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
  /**
   * 可选的第三个动作（如关闭守卫的「不保存」——危险但有意为之的路径）。
   * 排版在 取消 与 确认 之间。不传则维持原有两键形态，存量调用方零感知。
   */
  extraText?: string;
  onExtra?: () => void;
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
  extraText,
  onExtra,
}: ConfirmDialogProps) {
  const anim = useDialogAnim();

  /**
   * Esc = 取消。
   *
   * 🔴 这不是锦上添花，是在补一个缺口：本组件是来替代 `window.confirm` 的，
   * 而原生 confirm 按 Esc 就是取消。不接这一下，每换掉一处 window.confirm
   * 就在那处弄丢一个用户已经会了的操作。
   *
   * ❗ 只在 `open` 时挂，否则满屏都是没用的 window 监听。
   * 用 capture 阶段：弹窗开着的时候，Esc 应当先归它，
   * 不能让底下的页面（比如截图遮罩层）抢先把自己关了。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop z-confirm"
          onClick={onCancel}
        >
          <FocusTrap initialFocus="[data-autofocus]">
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
                {/* 安全默认（守护-2）：取消是唯一不丢东西的路，默认焦点与 Esc 都归它。
                    data-autofocus 供 FocusTrap 的 initialFocus 用——否则它会抢焦到头部 X。 */}
                <button className="btn-secondary" onClick={onCancel} autoFocus data-autofocus>
                  {cancelText}
                </button>
                {extraText && onExtra && (
                  <button className="btn-danger" onClick={onExtra}>
                    {extraText}
                  </button>
                )}
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
