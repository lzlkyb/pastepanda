import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { recSetPaused, recStatus, type RecStatus } from "@/lib/api/rec";

/** One backend clock/status query, without overlapping requests or local timer drift. */
export function useRecControlState(finalizing: boolean, onStop: (discard: boolean) => void | Promise<void>) {
  const [status, setStatus] = useState<RecStatus | null>(null);
  const [queryError, setQueryError] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState<{ action: "pause" | "resume" | "stop"; message: string } | null>(null);
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
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      void unlisten.then(fn => fn());
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
    failedAction: actionError?.action, setError, busy, togglePause, stop };
}
