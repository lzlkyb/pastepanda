import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock3, Info, TriangleAlert, X } from "lucide-react";

export type FeedbackTone = "info" | "success" | "warning" | "error" | "pending";

// One visual core serves local errors, persistent connection status and brief outcome notices.
// Dismissing a notice never changes the operation's outcome.
export function MobileFeedbackPreview({ tone, title, detail, action, technical, onDismiss, variant = "inline" }: {
  tone: FeedbackTone;
  title: string;
  detail?: string;
  action?: ReactNode;
  technical?: string;
  onDismiss?: () => void;
  variant?: "inline" | "banner" | "toast";
}) {
  const Icon = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle, pending: Clock3 }[tone];
  return <section className={`feedback feedback-${variant}`} data-tone={tone} role={tone === "error" ? "alert" : "status"} aria-atomic="true" aria-busy={tone === "pending"}>
    <div className="feedback-heading"><Icon size={20} aria-hidden="true" /><strong>{title}</strong>{onDismiss && <button className="dismiss" aria-label="关闭提示" onClick={onDismiss}><X size={18} /></button>}</div>
    {detail && <p>{detail}</p>}
    {(action || technical) && <div className="feedback-actions">{action}{technical && <details><summary>查看详情</summary><p className="technical">{technical}</p></details>}</div>}
  </section>;
}
