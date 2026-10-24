import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { recSetPaused, recStatus, type RecStatus } from "@/lib/api/rec";
import { formatRecordingTime } from "@/lib/utils";

/** One backend clock/status query, without overlapping requests or local timer drift. */
export function useRecControlState(finalizing: boolean, onStop: (discard: boolean) => void | Promise<void>) {
  const [status, setStatus] = useState<RecStatus | null>(null);
  const [queryError, setQueryError] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState<{ action: "pause" | "resume" | "stop"; message: string } | null>(null);
  /** R1（2026-10-24 审查）：标记热键的回话（≈2.4s 自动收掉）；null = 没有要显示的。 */
  const [markNote, setMarkNote] = useState<string | null>(null);
  const markTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const pausePending = useRef(false);
  const statusEpoch = useRef(0);
  useEffect(() => {
    if (finalizing) return;
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending || pausePending.current || document.hidden) return;
      pending = true;
      const epoch = statusEpoch.current;
      try {
        const next = await recStatus();
        if (alive && epoch === statusEpoch.current) {
          setStatus(next);
          setQueryError("");
        }
      } catch {
        if (alive && epoch === statusEpoch.current) setQueryError("无法确认录制状态，将自动重试；仍可停止并保存。");
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    const visible = () => void refresh();
    document.addEventListener("visibilitychange", visible);
    const unlisten = listen<{ paused: boolean }>("rec-paused", e => {
      if (alive) {
        statusEpoch.current += 1;
        setStatus(previous => previous ? { ...previous, paused: e.payload.paused } : previous);
      }
    });
    // R1：标记热键的回话。写上了 → 主条闪「已标记 mm:ss」；没写上（事件记录关）
    // → 走 error 通道：notice 面板自动展开，说清「为什么没记上 + 去哪开」。
    const unlistenMark = listen<{ recorded: boolean; elapsedMs?: number }>("rec-marked", e => {
      if (!alive) return;
      if (e.payload?.recorded) {
        setMarkNote(`已标记 ${formatRecordingTime(e.payload.elapsedMs ?? 0)}`);
        if (markTimer.current !== null) window.clearTimeout(markTimer.current);
        markTimer.current = window.setTimeout(() => setMarkNote(null), 2400);
      } else {
        setError("标记没记上：「记录点击与按键事件」未开启，本次录像不带标记（设置 → 录屏 → 记录点击与按键事件）。");
      }
    });
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      if (markTimer.current !== null) window.clearTimeout(markTimer.current);
      void unlisten.then(fn => fn());
      void unlistenMark.then(fn => fn());
    };
  }, [finalizing]);
  const togglePause = useCallback(async () => {
    if (pausePending.current || !status || status.starting) return false;
    const paused = !status.paused;
    // Queries started before this command cannot overwrite its confirmed pause state.
    statusEpoch.current += 1;
    pausePending.current = true;
    setBusy(true);
    try {
      await recSetPaused(paused);
      setStatus(previous => previous ? { ...previous, paused } : previous);
      setActionError(previous => previous?.action === "stop" ? previous : null);
      return true;
    } catch (cause) {
      setActionError({ action: paused ? "pause" : "resume", message: `${paused ? "暂停" : "继续"}失败：${cause instanceof Error ? cause.message : String(cause)}` });
      return false;
    } finally { pausePending.current = false; setBusy(false); }
  }, [status]);
  const stop = useCallback(async (discard = false) => {
    try {
      await onStop(discard);
      setActionError(null);
      return true;
    } catch (cause) {
      setActionError({ action: "stop", message: `停止失败：${cause instanceof Error ? cause.message : String(cause)}。会话尚未结束，请重试。` });
      return false;
    }
  }, [onStop]);
  return { status, error: [actionError?.message, error, queryError].filter(Boolean).join("；"),
    failedAction: actionError?.action, setError, markNote, busy, togglePause, stop };
}
