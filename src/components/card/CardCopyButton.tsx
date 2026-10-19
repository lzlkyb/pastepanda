import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyItemToClipboard } from "@/lib/api";
import type { HistoryItem } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import styles from "./CardCopyButton.module.css";

/** Feedback stays at the trigger; a recycled row cannot inherit another item's success. */
export function CardCopyButton({ item, className = "", tabIndex, onFeedbackChange }: { item: HistoryItem; className?: string; tabIndex?: number; onFeedbackChange?: (visible: boolean) => void }) {
  const [state, setState] = useState<"idle" | "pending" | "done">("idle");
  const generation = useRef({ version: 0 });
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const feedbackVisible = useRef(false);
  const { toast } = useToast();
  useEffect(() => {
    const token = generation.current;
    token.version++;
    setState("idle");
    return () => { token.version++; clearTimeout(reset.current); };
  }, [item.id]);
  // A pointer leaving during IPC or confirmation must not hide the result of its own click.
  useEffect(() => {
    const visible = state !== "idle";
    if (feedbackVisible.current === visible) return;
    feedbackVisible.current = visible;
    onFeedbackChange?.(visible);
  }, [state, onFeedbackChange]);
  useEffect(() => () => {
    if (feedbackVisible.current) onFeedbackChange?.(false);
  }, [onFeedbackChange]);

  const copy = async (feedback: "inline" | "toast" = "inline") => {
    const epoch = generation.current.version;
    if (feedback === "inline") {
      // A second click starts a new confirmation lifetime, even if the first is still showing.
      clearTimeout(reset.current);
      setState("pending");
    }
    try {
      const message = await copyItemToClipboard(item);
      if (feedback === "toast") { toast(message, "success"); return; }
      if (epoch !== generation.current.version) return;
      setState("done");
      clearTimeout(reset.current);
      reset.current = setTimeout(() => setState("idle"), 1500);
    } catch {
      if (feedback === "inline" && epoch === generation.current.version) {
        setState("idle");
      }
      // Row recycling must protect local state without hiding a failed user action.
      toast("复制失败，可重试。", "error", undefined, () => void copy("toast"), "重试复制");
    }
  };
  const label = state === "done" ? "已复制" : state === "pending" ? "复制中" : "复制";
  return <button type="button" className={`${className} ${styles.button}`}
    tabIndex={tabIndex} aria-label={label}
    data-confirmed={state === "done"} disabled={state === "pending"} aria-busy={state === "pending"}
    title={state === "done" ? "已复制到剪贴板" : "复制到剪贴板"}
    onMouseDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); event.preventDefault(); void copy(); }}>
    {state === "done" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    <span role="status">{label}</span>
  </button>;
}
