import { useCallback, useEffect, useRef, useState } from "react";
import { recTrim, recTrimCancel, recTrimStatus, type RecTrimResult } from "@/lib/api/rec";
import type { TrimRange } from "@/components/recsel/trimSnap";
import { listen } from "@tauri-apps/api/event";

/** 后端拥有任务。预览关窗只卸载观察者，重新打开可继续查询同一源文件。 */
export function useRecTrimTask(path: string) {
  const [saving, setSaving] = useState(false);
  const [percent, setPercent] = useState(0);
  const [saved, setSaved] = useState<RecTrimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queryFailed, setQueryFailed] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const querying = useRef<number | null>(null);
  const query = useCallback(async () => {
    const gen = generation.current;
    if (querying.current === gen) return;
    querying.current = gen;
    try {
      const status = await recTrimStatus(path);
      if (!alive.current || gen !== generation.current || !status) return;
      setSaving(status.running);
      setPercent(status.percent);
      setQueryFailed(false);
      setError(status.error);
      if (status.running) setSaved(null);
      if (status.donePath)
        setSaved({ path: status.donePath, bytes: 0, inMs: status.inMs ?? 0, outMs: status.outMs ?? 0 });
    } catch (e) {
      if (!alive.current || gen !== generation.current) return;
      setQueryFailed(true);
      setError(`裁剪状态读取失败：${e instanceof Error ? e.message : String(e)}。任务可能仍在后台，请重新查询。`);
    } finally {
      if (querying.current === gen) querying.current = null;
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void query();
    return () => {
      alive.current = false;
    };
  }, [query]);
  useEffect(() => {
    const unlisten = listen("rec-files-changed", () => void query());
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [query]);
  useEffect(() => {
    if (!saving || queryFailed) return;
    const timer = setInterval(() => void query(), 500);
    return () => clearInterval(timer);
  }, [saving, queryFailed, query]);
  const save = async (range: TrimRange) => {
    if (saving) return;
    generation.current++;
    const gen = generation.current;
    setSaving(true);
    setSaved(null);
    setError(null);
    setPercent(0);
    setQueryFailed(false);
    try {
      const result = await recTrim(path, range.inMs, range.outMs);
      if (alive.current && gen === generation.current) {
        generation.current++;
        setSaved(result);
        setSaving(false);
        setPercent(100);
      }
    } catch (e) {
      if (alive.current && gen === generation.current)
        setError(`裁剪未保存：${e instanceof Error ? e.message : String(e)}。原录像保留。`);
    } finally {
      if (alive.current && gen === generation.current) setSaving(false);
    }
  };
  const cancel = async () => {
    try {
      await recTrimCancel(path);
      await query();
    } catch (e) {
      if (alive.current)
        setError(`取消裁剪失败：${e instanceof Error ? e.message : String(e)}，可重试取消或继续等待。`);
    }
  };
  return { saving, percent, saved, error, queryFailed, query, save, cancel, clearSaved: () => setSaved(null) };
}
