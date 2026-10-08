import { useCallback, useEffect, useRef, useState } from "react";
import {
  mobileKnowledgeShareList, mobileKnowledgeShareListen, mobileKnowledgeShareAck,
  mobileKnowledgeSharePickImages, type MobileKnowledgeInbox,
} from "@/lib/api/mobileKnowledgeShare";
import { knowledgeErrorText } from "@/lib/utils";

type Flight = { epoch: number; again: boolean; promise: Promise<boolean> };
/** Cold-start shares precede JS. Re-read after subscribing and bound recovery to the foreground. */
export function useKnowledgeInbox() {
  const [inbox, setInbox] = useState<MobileKnowledgeInbox>({ items: [], processing: false, notice: "" });
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const epoch = useRef(0);
  const alive = useRef(false);
  const action = useRef<symbol | null>(null);
  const flight = useRef<Flight | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadline = useRef(0);
  const latest = useRef(inbox);
  const acknowledged = useRef(new Set<string>());
  const stopTimer = useCallback(() => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, []);

  const read = useCallback((renew = true): Promise<boolean> => {
    if (!alive.current || document.hidden) return Promise.resolve(false);
    const current = epoch.current;
    if (renew) deadline.current = 0;
    stopTimer();
    if (flight.current?.epoch === current) {
      flight.current.again = true;
      return flight.current.promise;
    }
    const pending: Flight = { epoch: current, again: false, promise: Promise.resolve(false) };
    flight.current = pending;
    setLoading(true);
    pending.promise = (async () => {
      let ok = false;
      try {
        do {
          pending.again = false;
          try {
            const next = await mobileKnowledgeShareList();
            if (!alive.current || epoch.current !== current) return false;
            if (!next || !Array.isArray(next.items)) throw new Error("待收集内容读取失败，请重试");
            // A list snapshot taken before a successful ack must not resurrect the consumed item.
            for (const id of acknowledged.current) if (!next.items.some(item => item.id === id)) acknowledged.current.delete(id);
            const visible = { ...next, items: next.items.filter(item => !acknowledged.current.has(item.id)) };
            latest.current = visible; setInbox(visible); setReady(true); setError(""); ok = true;
          } catch (cause) {
            if (alive.current && epoch.current === current) setError(knowledgeErrorText(cause));
            ok = false;
          }
        } while (pending.again && alive.current && epoch.current === current && !document.hidden);
        if (ok && latest.current.processing && !document.hidden && alive.current && epoch.current === current) {
          if (!deadline.current) deadline.current = Date.now() + 15_000;
          if (Date.now() < deadline.current) timer.current = setTimeout(() => { timer.current = null; void read(false); }, 500);
          else setError("图片仍在收集中，待处理内容已保留。请稍后重新检查。");
        } else if (ok && !latest.current.processing) deadline.current = 0;
        return ok;
      } finally {
        if (flight.current === pending) flight.current = null;
        if (alive.current && epoch.current === current) setLoading(false);
      }
    })();
    return pending.promise;
  }, [stopTimer]);
  const refresh = useCallback(() => read(true), [read]);

  useEffect(() => {
    const current = ++epoch.current; alive.current = true;
    const focus = () => { if (!document.hidden) void refresh(); else { stopTimer(); deadline.current = 0; } };
    let closed = false;
    let unregister: (() => void) | undefined;
    void Promise.resolve().then(() => mobileKnowledgeShareListen(focus)).then(listener => {
      const remove = () => { void Promise.resolve(listener.unregister()).catch(() => {}); };
      if (closed || epoch.current !== current) remove();
      else { unregister = remove; focus(); }
    }).catch(() => { /* Bounded processing checks and foreground reads recover missed native events. */ });
    focus();
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => {
      closed = true; if (epoch.current === current) { alive.current = false; ++epoch.current; stopTimer(); deadline.current = 0; }
      unregister?.(); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh, stopTimer]);

  const acknowledge = useCallback(async (id: string) => {
    if (action.current || !alive.current) return false;
    const token = Symbol(); const current = epoch.current;
    action.current = token; setBusy(true); setError("");
    try {
      await mobileKnowledgeShareAck(id);
      if (!alive.current || epoch.current !== current) return false;
      acknowledged.current.add(id);
      latest.current = { ...latest.current, items: latest.current.items.filter(item => item.id !== id) };
      setInbox(latest.current);
      await refresh(); return true;
    } catch (cause) { if (alive.current && epoch.current === current) setError(knowledgeErrorText(cause)); return false; }
    finally { if (action.current === token) action.current = null; if (alive.current && epoch.current === current) setBusy(false); }
  }, [refresh]);
  const pickImages = useCallback(async () => {
    if (action.current || !alive.current) return false;
    const token = Symbol(); const current = epoch.current;
    action.current = token; setPicking(true); setPickedId(null); setError("");
    try {
      const result = await mobileKnowledgeSharePickImages();
      if (!alive.current || epoch.current !== current) return false;
      const readOk = await refresh();
      const item = result.status === "collected" && result.incomingId ? latest.current.items.find(item => item.id === result.incomingId) : null;
      if (readOk && item && item.status !== "error" && item.images.length > 0) { setPickedId(item.id); return true; }
      return false;
    } catch (cause) { if (alive.current && epoch.current === current) setError(knowledgeErrorText(cause)); return false; }
    finally { if (action.current === token) action.current = null; if (alive.current && epoch.current === current) setPicking(false); }
  }, [refresh]);
  return { ...inbox, error, ready, loading, busy, picking, pickedId, refresh, acknowledge, pickImages };
}
