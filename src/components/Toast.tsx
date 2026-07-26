import { useState, useCallback, useMemo, createContext, useContext, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X, RotateCcw } from "lucide-react";
import styles from "./Toast.module.css";

type ToastType = "success" | "error" | "info" | "warning" | "loading";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
  onRetry?: () => void;
  actionLabel?: string;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType, duration?: number, onRetry?: () => void, actionLabel?: string) => void;
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const MAX_TOASTS = 5; // 最多同时显示 5 个 toast

  const toast = useCallback((message: string, type: ToastType = "info", duration?: number, onRetry?: () => void, actionLabel?: string) => {
    const d = duration ?? (type === "error" ? 5000 : 4000);
    const id = ++toastId;
    setToasts((prev) => {
      const next = [...prev, { id, type, message, duration: d, onRetry, actionLabel }];
      // 超出限制时移除最早的 toast
      if (next.length > MAX_TOASTS) {
        return next.slice(next.length - MAX_TOASTS);
      }
      return next;
    });
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), d);
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  // 稳定的 context value：避免每次 Provider 渲染（toast 列表变化）都让所有消费者重渲染
  const ctxValue = useMemo(() => ({ toast }), [toast]);

  const ICONS = {
    success: CheckCircle2,
    error: AlertCircle,
    warning: AlertTriangle,
    info: Info,
    loading: CheckCircle2, // 复用，通过 CSS spinner 区分
  };

  // 图标色块容器（每种类型独立配色）
  const ICON_BOX: Record<ToastType, string> = {
    success: styles.successBox,
    error: styles.errorBox,
    warning: styles.warningBox,
    info: styles.infoBox,
    loading: styles.loadingBox,
  };

  return (
    <ToastContext.Provider value={ctxValue}>
      {children}
      {/* Toast container */}
      <div className={styles.toastContainer}>
        <AnimatePresence>
          {toasts.map((t) => {
            const Icon = ICONS[t.type];
            return (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, x: 10 }}
                transition={{ duration: 0.2 }}
                className={`${styles.toastItem} ${styles[t.type]}`}
                style={{
                  pointerEvents: "auto",
                  "--toast-duration": `${t.duration}ms`,
                } as React.CSSProperties}
              >
                <span className={`${styles.toastIconBox} ${ICON_BOX[t.type]}`}>
                  {t.type === "loading" ? (
                    <span className={styles.toastSpinner} />
                  ) : (
                    <Icon size={14} className={styles.toastIcon} />
                  )}
                </span>
                <span className={styles.toastMsg}>{t.message}</span>
                {t.onRetry && t.actionLabel ? (
                  <button onClick={(e) => { e.stopPropagation(); t.onRetry?.(); dismiss(t.id); }} className={styles.toastAction}>
                    {t.actionLabel}
                  </button>
                ) : t.onRetry ? (
                  <button onClick={(e) => { e.stopPropagation(); t.onRetry?.(); dismiss(t.id); }} className={styles.toastRetry} title="重试">
                    <RotateCcw size={12} />
                  </button>
                ) : null}
                <button onClick={() => dismiss(t.id)} className={styles.toastClose}>
                  <X size={14} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
