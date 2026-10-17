import { useCallback, useEffect, useRef, useState } from "react";
import { recGifCancel, recGifStart, recGifStatus } from "@/lib/api/rec";

type GifState = {
  source: string;
  running: boolean;
  percent: number;
  donePath: string | null;
  error: string | null;
  queryFailed?: boolean;
};

/** 查询失败不冒充完成；保留源文件，让用户重新查询仍在后台的任务。 */
export function useRecGifExport(paths: string[]) {
  const [task, setTask] = useState<GifState | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const generation = useRef(0);
  const querying = useRef<number | null>(null);
  const restoreEpoch = useRef(0);
  const query = useCallback(async (source: string) => {
    const gen = generation.current;
    if (querying.current === gen) return;
    querying.current = gen;
    try {
      const result = await recGifStatus(source);
      if (gen !== generation.current) return;
      if (result && (result.running || result.donePath || result.error)) setTask({ source, ...result });
      else setTask((current) => (current?.source === source ? null : current));
    } catch (e) {
      if (gen !== generation.current) return;
      setTask((current) => ({
        source,
        running: false,
        percent: current?.percent ?? 0,
        donePath: null,
        error: `GIF 状态读取失败：${e instanceof Error ? e.message : String(e)}`,
        queryFailed: true,
      }));
    } finally {
      if (querying.current === gen) querying.current = null;
    }
  }, []);
  const restore = useCallback(async () => {
    const gen = generation.current;
    const epoch = ++restoreEpoch.current;
    setRestoring(true);
    const results = await Promise.allSettled(paths.map(async source => ({ source, ...await recGifStatus(source) })));
    if (epoch !== restoreEpoch.current || gen !== generation.current) return;
    const known = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const recovered = known.find(result => result.running) ?? known.find(result => result.donePath || result.error);
    if (recovered) setTask(recovered);
    else setTask(current => current && paths.includes(current.source) ? null : current);
    // A failed discovery cannot identify its task source. Keep that uncertainty separate
    // from a known source's polling error so another row cannot silently start work.
    setRestoreError(results.some(result => result.status === "rejected")
      ? "无法确认后台 GIF 导出任务状态，请重新查询后再启动导出。" : null);
    setRestoring(false);
  }, [paths]);
  useEffect(() => {
    const epoch = restoreEpoch;
    void restore();
    return () => {
      epoch.current++;
    };
  }, [restore]);
  useEffect(() => {
    if (!task?.running) return;
    let alive = true;
    const poll = async () => {
      if (alive) await query(task.source);
    };
    const timer = setInterval(() => void poll(), 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [task?.running, task?.source, query]);
  const start = async (source: string) => {
    if (starting || restoreError || task?.running || task?.queryFailed) return;
    const gen = ++generation.current;
    setRestoring(false);
    setStarting(source);
    try {
      await recGifStart(source);
      if (gen !== generation.current) return;
      setTask({ source, running: true, percent: 0, donePath: null, error: null });
    } catch (e) {
      if (gen !== generation.current) return;
      setTask({
        source,
        running: false,
        percent: 0,
        donePath: null,
        error: `GIF 导出失败：${e instanceof Error ? e.message : String(e)}`,
        queryFailed: true,
      });
    } finally {
      if (gen === generation.current) setStarting(null);
    }
  };
  const cancel = async () => {
    if (!task) return;
    try {
      await recGifCancel();
      await query(task.source);
    } catch (e) {
      setTask((current) => current && { ...current, error: `取消失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };
  return { task, starting, start, cancel, query, restoreError, restoring, restore };
}
