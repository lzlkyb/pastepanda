import { CONTENT_TRANSITION } from "@/lib/motion";
import { useInterfaceMotion } from "@/components/MotionPolicy";
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
  /**
   * 通用动作回调：渲染成 `actionLabel`（默认「撤销」）那个按钮，点完自动收起 toast。
   *
   * 为什么不是复用 `onRetry`：那个字段渲染出的按钮确实是通用动作按钮，名字却是「重试」。
   * 这里是**撤销**语义（远程申请撤回），塞进 `onRetry` 就是「名字在说谎」——
   * 本项目已经为同一类问题改过一次名（`setAllowed`，见 `useRcDeviceActions`）。
   * 与 `action === "undo"` 的区别：那条是历史记录的「撤销删除」，写死了 `restoreDeleted()`。
   */
  onAction?: () => void;
  /** 同文案无动作错误的合并计数（批次②）：连着失败时显示「已连续 N 次」。 */
  mergeCount?: number;
  /** 合并匹配用的原始文案（批次②）：显示文案带「（已连续 N 次）」后缀后不再等于原文。 */
  mergeBase?: string;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType, duration?: number, onRetry?: () => void, actionLabel?: string, copyText?: string, action?: string, onAction?: () => void) => void;
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
 * 批次②（通知治理 · 方案 A，2026-10-24）的时长口径。
 *
 * 改前 `error` 默认 duration=0 **常驻**——错误风暴时最多 5 条堆在右上角、
 * 逐条手关，是「通知频繁打扰」的第一根因。新口径：
 * - 无动作 error：[`ERROR_TOAST_MS`] 自动消失（悬停暂停/进度条照旧）；
 * - 带重试/撤销动作的 error：[`ERROR_ACTION_TOAST_MS`]——动作入口不能悄悄
 *   蒸发，但也不必永驻；
 * - success：[`SUCCESS_TOAST_MS`] 一闪而过（复制/粘贴是高频操作，4 秒太吵）；
 * - info：维持 4s（被动通知需要读完）。
 */
export const ERROR_TOAST_MS = 12000;
export const ERROR_ACTION_TOAST_MS = 30000;
export const SUCCESS_TOAST_MS = 2000;

/**
 * 一条 toast 的关闭计时器。
 *
 * `t !== 0` = 跑着，剩余 = `left - (now - startedAt)`；
 * `t === 0` = 停表中，剩余就是 `left`。
 */
type ToastTimer = { t: number; left: number; startedAt: number };

export function ToastProvider({ children }: { children: ReactNode }) {
  const mode = useInterfaceMotion();
  const background = useRef(false);
  background.current = mode === "hidden";
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const currentToasts = useRef<ToastItem[]>([]);
  const held = useRef(new Set<number>());
  const commit = useCallback((next: ToastItem[]) => { currentToasts.current = next; setToasts(next); }, []);
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
    held.current.delete(id);
    commit(currentToasts.current.filter((x) => x.id !== id));
  }, [commit]);

  const arm = useCallback((id: number, ms: number) => {
    if (ms <= 0) return;
    if (document.hidden || background.current) { timers.current.set(id, { t: 0, left: ms, startedAt: 0 }); return; }
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
    if (!e || e.t || held.current.has(id) || document.hidden || background.current) return;
    arm(id, e.left);
  }, [arm]);

  useEffect(() => {
    const sync = () => timers.current.forEach((_, id) => document.hidden || background.current ? pause(id) : resume(id));
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [pause, resume, mode]);

  // 卸载时把还没到点的都清掉，否则是对已卸载组件 setState。
  useEffect(() => {
    const m = timers.current;
    return () => { m.forEach((e) => e.t && window.clearTimeout(e.t)); m.clear(); };
  }, []);

  const toast = useCallback((message: string, type: ToastType = "info", duration?: number, onRetry?: () => void, actionLabel?: string, copyText?: string, action?: string, onAction?: () => void) => {
    const hasAction = Boolean(onRetry || onAction || action);
    // 批次②（方案 A）：error 不再常驻——无动作 12s、带动作 30s；success 缩到 2s。
    const d = duration ?? (type === "error"
      ? (hasAction ? ERROR_ACTION_TOAST_MS : ERROR_TOAST_MS)
      : type === "success" ? SUCCESS_TOAST_MS : 4000);
    // Recovery/undo actions belong to their own operation and must never merge.
    if (!hasAction) {
      // 批次②：同文案无动作错误仍在屏上时不堆新条，改为合并计数 + 重置计时。
      // 改前是静默丢弃——连着失败 5 次，用户只看到第 1 条，不知道还在持续失败。
      if (type === "error") {
        const prev = currentToasts.current.find(t =>
          t.type === "error" && t.mergeBase === message && !t.onRetry && !t.onAction && !t.action);
        if (prev) {
          const count = (prev.mergeCount ?? 1) + 1;
          commit(currentToasts.current.map(t => t.id === prev.id
            ? { ...t, message: `${message}（已连续 ${count} 次）`, mergeCount: count, duration: d }
            : t));
          const e = timers.current.get(prev.id);
          if (e?.t) window.clearTimeout(e.t);
          arm(prev.id, d);
          return;
        }
      }
      if (currentToasts.current.some(t =>
        t.type === type && t.message === message && t.copyText === copyText && !t.onRetry && !t.onAction && !t.action)) return;
    }
    const id = ++toastId;
    const next = [...currentToasts.current, {
      id, type, message, duration: d, onRetry, actionLabel, copyText, action, onAction,
      ...(type === "error" && !hasAction ? { mergeBase: message } : {}),
    }];
    const removed = next.splice(0, Math.max(0, next.length - MAX_TOASTS));
    removed.forEach(t => { const timer = timers.current.get(t.id); if (timer?.t) window.clearTimeout(timer.t); timers.current.delete(t.id); held.current.delete(t.id); });
    commit(next);
    arm(id, d);
  }, [arm, commit]);

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
          其余 toast 只做有界补位，不让文字参与回弹 */}
      <div className={styles.toastContainer}>
        <AnimatePresence mode="popLayout">
          {toasts.map((t) => {
            const Icon = ICONS[t.type];
            return (
              <motion.div
                key={t.id}
                layout="position"
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -3 }}
                transition={CONTENT_TRANSITION}
                className={`${styles.toastItem} ${styles[t.type]}`}
                role={t.type === "error" ? "alert" : "status"}
                data-timed={t.duration > 0}
                // U4.2：悬停暂停倒计时。底部那条进度条由 CSS 的
                // `animation-play-state: paused` 同步停住，两边看到的是同一件事。
                onMouseEnter={() => { held.current.add(t.id); pause(t.id); }}
                onMouseLeave={(e) => { if (!e.currentTarget.contains(document.activeElement)) { held.current.delete(t.id); resume(t.id); } }}
                onFocusCapture={() => { held.current.add(t.id); pause(t.id); }}
                onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && !e.currentTarget.matches(":hover")) { held.current.delete(t.id); resume(t.id); } }}
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
                {t.action === "undo" || t.onAction ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      // 有 onAction 就走调用方给的撤销动作（远程申请撤回等）；
                      // 没有才是历史记录那条写死的「撤销删除」。两条并成一支，
                      // 避免两个字段同时被设时渲染出两个「撤销」按钮。
                      if (t.onAction) t.onAction();
                      else void restoreDeleted();
                      dismiss(t.id);
                    }}
                    className={styles.toastAction}
                  >
                    {t.actionLabel ?? "撤销"}
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
                <button onClick={() => dismiss(t.id)} className={styles.toastClose} aria-label="关闭提示">
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
