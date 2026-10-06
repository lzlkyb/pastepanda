/**
 * RecRecentList — 工具箱「最近录制」区块（设计稿二期 §2）。
 *
 * 数据：rec_list_files 扫保存目录（不入库），进工具模式拉一次 + rec-done 追加刷新。
 * 行点击 = 系统播放器打开；行尾 📁 定位文件夹、✕ 删除（两段确认，3s 回退——
 * 同控制条「丢弃」的防误触心智）。
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  recDeleteFile,
  recListFiles,
  recOpenFile,
  recReveal,
  type RecFileMeta,
} from "@/lib/api/rec";
import styles from "./RecRecentList.module.css";
import tbStyles from "../ToolboxView.module.css";

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDur(ms: number | null): string {
  if (!ms || ms <= 0) return "--:--";
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function RecRecentList() {
  const [items, setItems] = useState<RecFileMeta[] | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(() => {
    recListFiles()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
    const un = listen("rec-done", load);
    return () => {
      void un.then((f) => f());
    };
  }, [load]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  if (items === null) return null; // 首拉未回：不渲染占位，避免骨架闪动

  const header = (
    <div className={tbStyles.section}>
      最近录制
      {items.length > 0 ? <span className={tbStyles.cnt}>{items.length}</span> : null}
    </div>
  );

  if (items.length === 0) {
    return (
      <div>
        {header}
        <div className={styles.empty}>
          还没有录制。
          <br />
          按 <kbd>Ctrl+Alt+R</kbd> 或点上方「屏幕录制」开始第一段。
        </div>
      </div>
    );
  }

  const open = (m: RecFileMeta) => {
    setActErr(null);
    recOpenFile(m.path).catch((e: unknown) =>
      setActErr(e instanceof Error ? e.message : String(e)),
    );
  };
  const reveal = (m: RecFileMeta) => {
    setActErr(null);
    recReveal(m.path).catch((e: unknown) =>
      setActErr(e instanceof Error ? e.message : String(e)),
    );
  };
  const remove = (m: RecFileMeta) => {
    if (armed !== m.path) {
      setArmed(m.path);
      return;
    }
    setArmed(null);
    recDeleteFile(m.path)
      .then(load)
      .catch((e: unknown) => setActErr(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div>
      {header}
      <div className={styles.list} role="list">
        {items.map((m) => (
          <div key={m.path} className={styles.item} role="listitem">
            <span className={styles.fic} aria-hidden="true">
              🎬
            </span>
            <button
              type="button"
              className={styles.name}
              title={`播放 ${m.name}`}
              onClick={() => open(m)}
            >
              {m.name}
            </button>
            <span className={styles.meta}>
              {fmtSize(m.bytes)} · {fmtDur(m.durationMs)}
            </span>
            <span className={styles.ops}>
              <button
                type="button"
                className={styles.op}
                title="打开所在文件夹"
                onClick={() => reveal(m)}
              >
                📁
              </button>
              <button
                type="button"
                className={`${styles.op}${armed === m.path ? ` ${styles.opArm}` : ""}`}
                title={armed === m.path ? "再点一次确认删除" : "删除（需再点一次确认）"}
                onClick={() => remove(m)}
              >
                {armed === m.path ? "确认删除？" : "✕"}
              </button>
            </span>
          </div>
        ))}
      </div>
      {actErr ? <div className={styles.err}>{actErr}</div> : null}
    </div>
  );
}
