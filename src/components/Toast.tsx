import { useState, useCallback, useMemo, useRef, useEffect, createContext, useContext, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X, RotateCcw, Copy, Check } from "lucide-react";
import styles from "./Toast.module.css";
import { copyToClipboard } from "@/lib/utils";
import { restoreDeleted } from "@/lib/api/history";

type ToastType = "success" | "error" | "info" | "warning" | "loading";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
  onRetry?: () => void;
  actionLabel?: string;
  copyText?: string;
  action?: string;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType, duration?: number, onRetry?: () => void, actionLabel?: string, copyText?: string, action?: string) => void;
}

/** toast 函数签名。各组件 props 里原本各写各的窄版本，收口到这里（规则 #11）。 */
export type ToastFn = ToastContextType["toast"];

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let toastId = 0;

/**
 * 撤销窗口。UI 规则 U4.2：撤销条 4–10 秒自动消失（Material snackbar 口径），
 * 本项目统一取 **6 秒**——够看清一句话并伸手点一下。
 * 蒸馏区那条撤销条用的是同一个数（规则 #11：口径单一来源）。
 */
export const UNDO_WINDOW_MS = 6000;

/**
 * 一条 toast 的关闭计时器。
 *
 * `t !== 0` = 跑着，剩余 = `left - (now - startedAt)`；
 * `t === 0` = 停表中，剩余就是 `left`。
 */
type ToastTimer = { t: number; left: number; startedAt: number };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const MAX_TOASTS = 5; // 最多同时显示 5 个 toast

  /**
   * 🔴 为什么不能沿用原来那句裸 `setTimeout`：U4.2 要求**悬停暂停倒计时**。
   * 正把鼠标移过去要点「撤销」、toast 却自己没了，是最气人的一种交互——
   * 而带撤销的 toast 恰恰是唯一一种**必须点中**的 toast。
   *
   * 存「剩余时间」而不是离开时重新计满，是为了和底部那条进度条对齐：
   * CSS 那边用的是 `animation-play-state: paused`，它是**续播不重播**的。
   */
  const timers = useRef(new Map<number, ToastTimer>());

  const dismiss = useCallback((id: number) => {
    const e = timers.current.get(id);
    if (e) {
      if (e.t) window.clearTimeout(e.t);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const arm = useCallback((id: number, ms: number) => {
    const t = window.setTimeout(() => dismiss(id), ms);
    timers.current.set(id, { t, left: ms, startedAt: Date.now() });
  }, [dismiss]);

  /** 鼠标进来：停表。 */
  const pause = useCallback((id: number) => {
    const e = timers.current.get(id);
    if (!e || !e.t) return;
    window.clearTimeout(e.t);
    timers.current.set(id, { t: 0, left: Math.max(0, e.left - (Date.now() - e.startedAt)), startedAt: 0 });
  }, []);

  /** 鼠标离开：按**剩下的**时间续上，不是重新计满。 */
  const resume = useCallback((id: number) => {
    const e = timers.current.get(id);
    if (!e || e.t) return;
    arm(id, e.left);
  }, [arm]);

  // 卸载时把还没到点的都清掉，否则是对已卸载组件 setState。
  useEffect(() => {
    const m = timers.current;
    return () => { m.forEach((e) => e.t && window.clearTimeout(e.t)); m.clear(); };
  }, []);

  const toast = useCallback((message: string, type: ToastType = "info", duration?: number, onRetry?: () => void, actionLabel?: string, copyText?: string, action?: string) => {
    const d = duration ?? (type === "error" ? 5000 : 4000);
    const id = ++toastId;
    setToasts((prev) => {
      const next = [...prev, { id, type, message, duration: d, onRetry, actionLabel, copyText, action }];
      // 超出限制时移除最早的 toast
      if (next.length > MAX_TOASTS) {
        return next.slice(next.length - MAX_TOASTS);
      }
      return next;
    });
    arm(id, d);
  }, [arm]);

  // 复制反馈状态：记录当前处于「已复制」态的 toast id（1.5s 后复原，不弹额外 toast）
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const handleCopy = useCallback(async (t: ToastItem) => {
    const ok = await copyToClipboard(t.copyText ?? t.message);
    if (ok) {
      setCopiedId(t.id);
      setTimeout(() => setCopiedId((prev) => (prev === t.id ? null : prev)), 1500);
    } else {
      toast("复制失败", "error");
    }
  }, [toast]);

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
      {/* Toast container — popLayout：退场 toast 立即脱离文档流（framer 固定其尺寸/位置），
          其余 toast 由 layout 弹簧平滑补位，消除原先卸载瞬间的跳变 */}
      <div className={styles.toastContainer}>
        <AnimatePresence mode="popLayout">
          {toasts.map((t) => {
            const Icon = ICONS[t.type];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, x: 10 }}
                transition={{ duration: 0.2, layout: { type: "spring", stiffness: 550, damping: 38 } }}
                className={`${styles.toastItem} ${styles[t.type]}`}
                // U4.2：悬停暂停倒计时。底部那条进度条由 CSS 的
                // `animation-play-state: paused` 同步停住，两边看到的是同一件事。
                onMouseEnter={() => pause(t.id)}
                onMouseLeave={() => resume(t.id)}
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
                {t.action === "undo" ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); void restoreDeleted(); dismiss(t.id); }}
                    className={styles.toastAction}
                  >
                    撤销
                  </button>
                ) : null}
                {t.onRetry && t.actionLabel ? (
                  <button onClick={(e) => { e.stopPropagation(); t.onRetry?.(); dismiss(t.id); }} className={styles.toastAction}>
                    {t.actionLabel}
                  </button>
                ) : t.onRetry ? (
                  <button onClick={(e) => { e.stopPropagation(); t.onRetry?.(); dismiss(t.id); }} className={styles.toastRetry} title="重试">
                    <RotateCcw size={12} />
                  </button>
                ) : null}
                {t.type === "error" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCopy(t); }}
                    className={`${styles.toastCopy}${copiedId === t.id ? " " + styles.copied : ""}`}
                    title="复制错误信息"
                  >
                    {copiedId === t.id ? (
                      <>
                        <Check size={12} /> 已复制
                      </>
                    ) : (
                      <Copy size={12} />
                    )}
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
