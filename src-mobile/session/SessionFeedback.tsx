import { useEffect, useState, type ReactNode } from "react";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import type { useSessionClipboard } from "./useSessionClipboard";
import type { useSessionPointer } from "./useSessionPointer";
import type { useOrientationLock } from "./useOrientationLock";
import type { RcSettingKey } from "@/lib/api/rcCommands";
import ui from "../ui/MobileUi.module.css";
import styles from "./SessionFeedback.module.css";
import { useMobileNoticeTimer } from "../ui/useMobileNoticeTimer";

type Issue = { feedback: MobileFeedback; dismiss: () => void; action?: ReactNode };
/** One compact summary outside the video; details never stack over remote targets. */
export function SessionFeedback({ pointer, orient, clipboard, sendFailed, onSendFailDismiss,
  blocked = false, compact = false, onOpenChange, setting, settings, onSettingDismiss, onSettingOpen,
}: {
  pointer: Pick<ReturnType<typeof useSessionPointer>, "hint" | "hintTone" | "clearHint">;
  orient: Pick<ReturnType<typeof useOrientationLock>, "hint" | "clearHint">;
  clipboard: ReturnType<typeof useSessionClipboard>;
  sendFailed?: boolean;
  onSendFailDismiss: () => void;
  blocked?: boolean;
  compact?: boolean;
  onOpenChange?: (open: boolean) => void;
  setting?: MobileFeedback;
  settings?: { key: RcSettingKey; feedback: MobileFeedback }[];
  onSettingDismiss?: (key?: RcSettingKey) => void;
  onSettingOpen?: (key?: RcSettingKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const issues: Issue[] = [];
  if (sendFailed) issues.push({ feedback: { tone: "error", title: "输入发送失败", detail: "请检查连接；恢复后继续操作。" }, dismiss: onSendFailDismiss });
  if (orient.hint) issues.push({ feedback: { tone: "error", title: "显示方向未能切换", detail: orient.hint }, dismiss: orient.clearHint });
  if (!clipboard.clipOpen && clipboard.feedback) issues.push({ feedback: clipboard.feedback, dismiss: clipboard.dismiss,
    action: <button type="button" className={ui.textButton} onClick={() => { setOpen(false); clipboard.openClip(); }}>打开剪贴板</button> });
  for (const item of settings ?? (setting ? [{ key: undefined, feedback: setting }] : [])) {
    issues.push({ feedback: item.feedback, dismiss: () => onSettingDismiss?.(item.key),
      action: <button type="button" className={ui.textButton} onClick={() => { setOpen(false); onSettingOpen?.(item.key); }}>查看设置</button> });
  }
  if (pointer.hint) issues.push({ feedback: { tone: pointer.hintTone, title: pointer.hint }, dismiss: pointer.clearHint });
  const first = issues.find(issue => issue.feedback.tone === "error") ?? issues.find(issue => issue.feedback.tone === "warning") ?? issues[0];
  const hasIssues = !!first;
  useEffect(() => { if (!hasIssues) setOpen(false); }, [hasIssues]);
  const detailsOpen = open && !!first && !blocked;
  useEffect(() => { onOpenChange?.(detailsOpen); return () => onOpenChange?.(false); }, [detailsOpen, onOpenChange]);
  const dismiss = first?.dismiss;
  const title = first?.feedback.title;
  const ordinary = first?.feedback.tone === "info" || first?.feedback.tone === "success";
  useMobileNoticeTimer(ordinary, title, dismiss ?? (() => {}), blocked || open || focused);
  if (!first) return null;
  return <>
    {!blocked && <div className={`${styles.summary} ${compact ? styles.compact : ""}`} role={first.feedback.tone === "error" ? "alert" : "status"} aria-atomic="true"
      onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}>
      <span>{first.feedback.title}</span>
      <button type="button" onClick={() => setOpen(true)}>{issues.length > 1 ? `${issues.length} 条提示` : "详情"}</button>
      <button type="button" onClick={first.dismiss} aria-label="关闭提示">关闭</button>
    </div>}
    <MobileSheet open={detailsOpen} title="会话提示" onClose={() => setOpen(false)}>
      {issues.map((issue, index) => <MobileNotice key={`${index}:${issue.feedback.title}`} {...issue.feedback}
        onDismiss={issue.dismiss} action={issue.action} />)}
      <button type="button" className={ui.secondary} onClick={() => setOpen(false)}>返回远程画面</button>
    </MobileSheet>
  </>;
}
