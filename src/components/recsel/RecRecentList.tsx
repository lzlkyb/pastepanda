/**
 * RecRecentList — 工具箱「最近录制」区块（设计稿 §06）。
 *
 * 外壳只做四件事：读列表、全局 GIF 发现失败的恢复位、空态一句、把行映射出来。
 * 行的全部外观与交互在 RecRecentRow——本文件不碰任何一行样式细节。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { recListFiles, type RecFileMeta } from "@/lib/api/rec";
import { useAppStore } from "@/stores/appStore";
import { toolShortcutLabel } from "@/lib/utils";
import { useRecGifExport } from "@/hooks/useRecGifExport";
import styles from "./RecRecentList.module.css";
import tbStyles from "../ToolboxView.module.css";
import { RecRecentRow } from "./RecRecentRow";

export function RecRecentList() {
  const recordingKey = useAppStore((s) => s.config.rec_hotkey);
  const recordingLabel = toolShortcutLabel("screenrec", undefined, { rec_hotkey: recordingKey });
  const [items, setItems] = useState<RecFileMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const paths = useMemo(() => items?.map((item) => item.path) ?? [], [items]);
  const gif = useRecGifExport(paths);
  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    recListFiles()
      .then(setItems)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
    const un = listen("rec-done", load);
    const changed = listen("rec-files-changed", load);
    return () => {
      void un.then((f) => f());
      void changed.then((f) => f());
    };
  }, [load]);
  const run = (action: () => Promise<unknown>) => {
    setActErr(null);
    void action().catch((error: unknown) => setActErr(error instanceof Error ? error.message : String(error)));
  };
  return (
    <section aria-label="最近录制">
      <div className={tbStyles.section}>
        最近录制{items?.length ? <span className={tbStyles.cnt}>{items.length}</span> : null}
      </div>
      {gif.restoreError && (
        <div className={styles.err} role="alert">
          <p>无法确认后台 GIF 导出任务状态，请重新查询后再启动导出。</p>
          <button type="button" className={styles.link} disabled={gif.restoring} onClick={() => void gif.restore()}>
            {gif.restoring ? "正在查询 GIF 任务…" : "重新查询 GIF 任务"}
          </button>
        </div>
      )}
      {loading && (
        <div className={styles.empty} role="status">
          正在读取最近录制…
        </div>
      )}
      {loadError && (
        <div className={styles.err} role="alert">
          <p>暂时无法读取录屏目录：{loadError}。请确认保存位置可访问后重试。</p>
          <button type="button" className={styles.link} onClick={load}>
            重新加载
          </button>
        </div>
      )}
      {!loading && !loadError && items?.length === 0 && (
        <div className={styles.empty}>
          {recordingLabel ? (
            <>
              还没有录制，按 <kbd>{recordingLabel}</kbd> 开始
            </>
          ) : (
            "还没有录制，从上方「屏幕录制」开始第一段。"
          )}
        </div>
      )}
      {!loadError && items && items.length > 0 && (
        <div className={styles.list} role="list">
          {items.map((file) => (
            <RecRecentRow key={file.path} file={file} gif={gif} run={run} reload={load} />
          ))}
        </div>
      )}
      {actErr && (
        <div className={styles.err} role="alert">
          {actErr}
        </div>
      )}
    </section>
  );
}
