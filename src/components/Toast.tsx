import { useState, useCallback, createContext, useContext, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X, RotateCcw } from "lucide-react";
import styles from "./Toast.module.css";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
  onRetry?: () => void;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType, duration?: number, onRetry?: () => void) => void;
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const MAX_TOASTS = 5; // 最多同时显示 5 个 toast

  const toast = useCallback((message: string, type: ToastType = "info", duration?: number, onRetry?: () => void) => {
    const d = duration ?? (type === "error" ? 5000 : 4000);
    const id = ++toastId;
    setToasts((prev) => {
      const next = [...prev, { id, type, message, duration: d, onRetry }];
      // 超出限制时移除最早的 toast
      if (next.length > MAX_TOASTS) {
        return next.slice(next.length - MAX_TOASTS);
      }
      return next;
    });
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), d);
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const ICONS = {
    success: CheckCircle2,
    error: AlertCircle,
    warning: AlertTriangle,
    info: Info,
  };

  return (
    <ToastContext.Provider value={{ toast }}>
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
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className={`${styles.toastItem} ${styles[t.type]}`}
                style={{
                  pointerEvents: "auto",
                  boxShadow: "var(--shadow-md)",
                  "--toast-duration": `${t.duration}ms`,
                } as React.CSSProperties}
              >
                <Icon size={16} className={styles.toastIcon} />
                <span className={styles.toastMsg}>{t.message}</span>
                {t.onRetry && (
                  <button onClick={(e) => { e.stopPropagation(); t.onRetry?.(); dismiss(t.id); }} className={styles.toastRetry} title="重试">
                    <RotateCcw size={12} />
                  </button>
                )}
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
