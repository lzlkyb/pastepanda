import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";

type Entry = { id: string; key: string; priority: number; order: number; dismiss: () => void };
const entries = new Map<string, Entry>();
const subscribers = new Set<() => void>();
let order = 0;
const winner = () => [...entries.values()].reduce<Entry | undefined>((best, entry) =>
  !best || entry.priority > best.priority || (entry.priority === best.priority && entry.order > best.order) ? entry : best, undefined)?.id ?? "";
const publish = () => subscribers.forEach(callback => callback());
const subscribe = (callback: () => void) => { subscribers.add(callback); return () => { subscribers.delete(callback); }; };

/** One viewport notice; local flow feedback keeps the owning task's independent visibility. */
export function useFloatingNotice(floating: boolean, tone: string, title: ReactNode, detail: ReactNode, dismiss: () => void) {
  const id = useId();
  const callback = useRef(dismiss); callback.current = dismiss;
  const priority = tone === "error" ? 3 : tone === "warning" ? 2 : tone === "pending" ? 1 : 0;
  // Only textual outcomes are deduplicated; rich nodes cannot be compared by meaning.
  const key = typeof title === "string" && (!detail || typeof detail === "string") ? `${tone}:${title}:${detail || ""}` : id;
  useEffect(() => {
    if (!floating) return;
    entries.set(id, { id, key, priority, order: ++order, dismiss: () => callback.current() }); publish();
    return () => { entries.delete(id); publish(); };
  }, [floating, id, key, priority]);
  const visible = useSyncExternalStore(subscribe, winner, () => "");
  return { visible: !floating || visible === id, dismiss: () => {
    if (!floating) { callback.current(); return; }
    const group = [...entries.values()].filter(entry => entry.key === key);
    group.forEach(entry => entry.dismiss());
  } };
}
