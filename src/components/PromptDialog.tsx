/**
 * PromptDialog —— 与 ConfirmDialog 同一视觉语言的单行输入弹窗。
 * 由 PromptDialogHost 渲染；用法见 lib/prompt.ts。
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";

interface PromptDialogProps {
  open: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  /** 确定：回传当前输入（可能为空串，由调用方校验）。 */
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  open,
  title,
  message,
  placeholder,
  defaultValue = "",
  confirmText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const anim = useDialogAnim();
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时同步初值并聚焦。open 从 false→true 才重置，避免打字过程中被覆盖。
  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    // 等一帧再聚焦：动画/portal 刚挂上时 input 可能还没进布局
    const t = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(t);
  }, [open, defaultValue]);

  // Esc = 取消（同 ConfirmDialog：capture 阶段，不让底下页面抢走）
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
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className="dialog-box w400"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                onConfirm(value);
              }}
            >
              <div className="dialog-header">
                <h2 className="dialog-title">{title}</h2>
                <button onClick={onCancel} className="dialog-close">
                  <X size={16} />
                </button>
              </div>

              <div
                className="dialog-body"
                style={{ "--dialog-body-gap": "10px" } as React.CSSProperties}
              >
                {message && (
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--text-secondary)",
                      lineHeight: 1.5,
                      margin: 0,
                    }}
                  >
                    {message}
                  </p>
                )}
                <input
                  ref={inputRef}
                  type="text"
                  className="prompt-input"
                  value={value}
                  placeholder={placeholder}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onConfirm(value);
                    }
                  }}
                />
              </div>

              <div
                className="dialog-footer"
                style={{ justifyContent: "flex-end" }}
              >
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn-secondary" onClick={onCancel}>
                    {cancelText}
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => onConfirm(value)}
                    autoFocus
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
