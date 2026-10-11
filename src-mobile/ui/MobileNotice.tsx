import { useRef, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock3, Info, TriangleAlert, X } from "lucide-react";
import styles from "./MobileNotice.module.css";
import { useMobileFeedbackMotion } from "./useMobileFeedbackMotion";

export type MobileNoticeTone = "info" | "success" | "warning" | "error" | "pending";
export type MobileFeedback = { tone: MobileNoticeTone; title: string; detail?: string };
export type MobileNoticeProps = {
  children?: ReactNode;
  error?: boolean;
  tone?: MobileNoticeTone;
  title?: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  /** Only prepared, non-sensitive diagnostics; never pass an exception object here. */
  technical?: string;
  onDismiss?: () => void;
  variant?: "inline" | "banner" | "toast";
  compact?: boolean;
  urgency?: "polite" | "assertive";
};

export function MobileNotice({
  children,
  error = false,
  tone = error ? "error" : "info",
  title,
  detail,
  action,
  technical,
  onDismiss,
  variant = "inline",
  compact = false,
  urgency = "polite",
}: MobileNoticeProps) {
  const root = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null);
  const refreshMotion = useMobileFeedbackMotion(root, content, tone);
  const Icon = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle, pending: Clock3 }[tone];
  return (
    <section ref={root} className={`${styles.notice} ${styles[variant]} ${compact ? styles.compact : ""}`} data-tone={tone}
      role={urgency === "assertive" ? "alert" : "status"} aria-atomic="true" aria-busy={tone === "pending"}>
      <div ref={content} className={styles.content}>
      <div className={styles.heading}>
        <span className={styles.icon} aria-hidden="true"><Icon size={18} /></span>
        <strong>{title ?? children}</strong>
        {onDismiss && <button type="button" className={styles.dismiss} aria-label="关闭提示" onClick={onDismiss}><X size={18} aria-hidden="true" /></button>}
      </div>
      {detail && <p className={styles.detail}>{detail}</p>}
      {(action || technical) && <div className={styles.actions}>{action}{technical && <details onToggle={refreshMotion}>
        <summary>查看详情</summary><p className={styles.technical}>{technical}</p>
      </details>}</div>}
      </div>
    </section>
  );
}
