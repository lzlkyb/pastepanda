import { useCallback, useEffect, useRef, useState } from "react";
import { rcPullClipboard, rcPushClipboard } from "@/lib/api/rc";
import { rcErrorText } from "../devices/rcErrorText";
import type { MobileFeedback } from "../ui/MobileNotice";

/** Keep feedback with its buttons, including failures and retries. */
export function useSessionClipboard() {
  const [feedback, setFeedback] = useState<MobileFeedback | null>(null);
  const [clipOpen, setClipOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  const last = useRef<"push" | "pull">("push");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dismiss = useCallback(() => setFeedback(null), []);
  const toggleClip = useCallback(() => setClipOpen(v => !v), []);
  const openClip = useCallback(() => setClipOpen(true), []);
  const run = useCallback(async (direction: "push" | "pull") => {
    if (locked.current) return;
    locked.current = true;
    last.current = direction;
    setBusy(true);
    setClipOpen(true);
    setFeedback({ tone: "pending", title: direction === "push" ? "正在推送剪贴板…" : "正在取回剪贴板…" });
    let stage: "phone" | "remote" = direction === "push" ? "phone" : "remote";
    const report = (next: MobileFeedback) => { if (alive.current) setFeedback(next); };
    try {
      const text = direction === "push" ? await navigator.clipboard.readText() : await rcPullClipboard();
      if (!alive.current) return;
      if (text == null) {
        report({ tone: "error", title: "未能取回电脑剪贴板", detail: "请确认电脑仍在线，然后重试。" });
        return;
      }
      if (!text) {
        report({ tone: "info", title: direction === "push" ? "手机剪贴板是空的" : "电脑剪贴板是空的", detail: "先复制文字，再试一次。" });
        return;
      }
      stage = direction === "push" ? "remote" : "phone";
      if (direction === "push") await rcPushClipboard(text);
      else await navigator.clipboard.writeText(text);
      report({ tone: "success", title: direction === "push" ? "已推送到电脑" : "已复制到手机", detail: `${text.length} 字符` });
    } catch (error) {
      report({ tone: "error", title: direction === "push" ? "剪贴板未能推到电脑" : "剪贴板未能取到手机",
        detail: stage === "phone" ? "无法访问手机剪贴板，请检查系统的剪贴板访问设置后重试。" : rcErrorText(error) });
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  const push = useCallback(() => run("push"), [run]);
  const pull = useCallback(() => run("pull"), [run]);
  const retry = useCallback(() => run(last.current), [run]);
  return { feedback, hint: feedback?.title ?? "", clipOpen, toggleClip, openClip, push, pull, retry, dismiss, busy };
}
