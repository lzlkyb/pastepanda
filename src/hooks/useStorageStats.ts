import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  cancelStorageRequest, getStorageDatabase, getStorageOverview,
  type DatabaseUsage, type StorageOverview,
} from "@/lib/api/storage";
import { useWindowVisible } from "./useWindowVisible";

export function useStorageStats(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  const windowVisible = useWindowVisible();
  const active = inView && windowVisible;
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [database, setDatabase] = useState<DatabaseUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [databaseError, setDatabaseError] = useState("");
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const requests = useRef(new Set<string>());
  const started = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const observer = new IntersectionObserver(entries => setInView(entries.some(e => e.isIntersecting)), { rootMargin: "120px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);

  const request = useCallback(async <T,>(work: (id: string) => Promise<T>) => {
    const id = crypto.randomUUID();
    requests.current.add(id);
    try { return await work(id); }
    finally { requests.current.delete(id); }
  }, []);

  const cancel = useCallback(() => {
    generation.current++;
    for (const id of requests.current) void cancelStorageRequest(id).catch(() => {});
    requests.current.clear();
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    cancel();
    const seq = generation.current;
    started.current = true; dirty.current = false;
    setLoading(true); setError(""); setDatabaseError("");
    setStale(false); setRevision(v => v + 1);
    // Fast metadata paints the database total before the potentially lengthy directory scan.
    const files = (async () => {
      try {
        const fast = await request(id => getStorageOverview(id, false));
        if (generation.current !== seq) return;
        setOverview(fast);
        const full = await request(id => getStorageOverview(id, true));
        if (generation.current === seq) setOverview(full);
      } catch {
        if (generation.current === seq) setError("文件占用统计失败，保留已读取结果，请重试。");
      }
    })();
    const tables = request(getStorageDatabase).then(value => {
      if (generation.current === seq) setDatabase(value);
    }).catch(() => {
      if (generation.current === seq) setDatabaseError("表占用统计失败，请刷新重试。");
    });
    await Promise.all([files, tables]);
    if (generation.current === seq) setLoading(false);
  }, [cancel, request]);

  useEffect(() => {
    if (active && (!started.current || dirty.current)) void refresh();
    if (!active) { dirty.current = true; cancel(); }
  }, [active, refresh, cancel]);

  useEffect(() => {
    const changed = () => { setStale(true); };
    const invalidate = () => { dirty.current = true; if (active) void refresh(); };
    window.addEventListener("counts-invalidated", changed);
    window.addEventListener("storage-usage-invalidated", invalidate);
    return () => {
      window.removeEventListener("counts-invalidated", changed);
      window.removeEventListener("storage-usage-invalidated", invalidate);
    };
  }, [active, refresh]);

  useEffect(() => {
    const pending = requests.current;
    const guard = generation;
    return () => { guard.current++; for (const id of pending) void cancelStorageRequest(id).catch(() => {}); };
  }, []);

  return { active, overview, database, loading, error, databaseError, stale, revision, refresh, cancel };
}
