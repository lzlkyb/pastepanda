/**
 * RecRecentList — 工具箱「最近录制」区块（设计稿二期 §2）。
 *
 * 数据：rec_list_files 扫保存目录（不入库），进工具模式拉一次 + rec-done 追加刷新。
 * 行点击 = 系统播放器打开；行尾 GIF 导出（四期 1.5：行内进度、点击取消）、
 * ✂ 预览裁剪、📁 定位文件夹、✕ 删除（两段确认，3s 回退）。
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  recDeleteFile,
  recGifCancel,
  recGifStart,
  recGifStatus,
  recListFiles,
  recOpenFile,
  recOpenPreview,
  recReveal,
  type RecFileMeta,
} from "@/lib/api/rec";
import styles from "./RecRecentList.module.css";
import { useAppStore } from "@/stores/appStore";
import { toolShortcutLabel } from "@/lib/utils";
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
  const recordingKey = useAppStore((s) => s.config.rec_hotkey);
  const recordingLabel = toolShortcutLabel("screenrec", undefined, { rec_hotkey: recordingKey });
  const [items, setItems] = useState<RecFileMeta[] | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  // GIF 导出（四期 1.5）：单任务串行——同一时刻至多一行在跑，500ms 轮询进度；
  // 完成态在按钮上闪 ✓ 4s（GIF 不进 mp4 列表，路径通过打开文件夹触达）
  const [gifRun, setGifRun] = useState<string | null>(null);
  const [gifPct, setGifPct] = useState(0);
  const [gifDone, setGifDone] = useState<string | null>(null);

  const load = useCallback(() => {
    recListFiles()
      .then(setItems)
      .catch(() => setItems([]));
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

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  // GIF 进度轮询（仅跑任务时挂表）；结束态分派到 ✓ 闪示或错误行
  useEffect(() => {
    if (!gifRun) return;
    let dead = false;
    const src = gifRun;
    const t = setInterval(() => {
      void recGifStatus(src)
        .then((s) => {
          if (dead) return;
          if (s.running) {
            setGifPct(s.percent);
            return;
          }
          setGifRun(null);
          if (s.error) {
            setActErr(`GIF 导出：${s.error}`);
          } else {
            setGifDone(src);
            setTimeout(() => setGifDone((cur) => (cur === src ? null : cur)), 4000);
          }
        })
        .catch(() => {});
    }, 500);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [gifRun]);

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
          {recordingLabel ? <>按 <kbd>{recordingLabel}</kbd> 或</> : null}点击上方「屏幕录制」开始第一段。
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
  const preview = (m: RecFileMeta) => {
    setActErr(null);
    recOpenPreview(m.path).catch((e: unknown) =>
      setActErr(e instanceof Error ? e.message : String(e)),
    );
  };
  const startGif = (m: RecFileMeta) => {
    setActErr(null);
    recGifStart(m.path)
      .then(() => {
        setGifPct(0);
        setGifRun(m.path);
      })
      .catch((e: unknown) => setActErr(e instanceof Error ? e.message : String(e)));
  };
  const cancelGif = () => {
    recGifCancel().catch((e: unknown) =>
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
                className={`${styles.op}${gifRun === m.path ? ` ${styles.opGif}` : ""}`}
                title={
                  gifRun === m.path
                    ? "点击取消导出（丢弃半成品）"
                    : "导出 GIF（12fps · 宽≤480 · 循环）"
                }
                onClick={() => (gifRun === m.path ? cancelGif() : startGif(m))}
              >
                {gifRun === m.path ? `${gifPct}%` : gifDone === m.path ? "✓" : "GIF"}
              </button>
              <button
                type="button"
                className={styles.op}
                title="预览 / 掐头去尾"
                onClick={() => preview(m)}
              >
                ✂
              </button>
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
