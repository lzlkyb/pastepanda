import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatStorageBytes } from "@/lib/utils";
import { useStorageStats } from "@/hooks/useStorageStats";
import { StorageCharts, type StorageCategory } from "./StorageCharts";
import settings from "../../Settings.module.css";
import styles from "./Storage.module.css";

export function StoragePanel() {
  const ref = useRef<HTMLDivElement>(null);
  const stats = useStorageStats(ref);
  const [feedback, setFeedback] = useState("");
  const categories = useMemo<StorageCategory[]>(() => ([
    ["database", "数据库"], ["images", "图片与截图"], ["cache", "缓存"], ["other", "其他文件"],
  ] as const).map(([key, label]) => {
    const files = stats.overview?.files.filter(f => f.category === key) ?? [];
    return { key, label, bytes: files.reduce((sum, f) => sum + f.bytes, 0), complete: !!stats.overview && files.every(f => f.complete) };
  }).filter(c => c.key !== "other" || c.bytes > 0 || !c.complete), [stats.overview]);
  useEffect(() => { setFeedback(""); }, [stats.revision]);
  const action = async (kind: "copy" | "open") => {
    if (!stats.overview) return;
    try {
      if (kind === "copy") {
        await invoke("copy_only", { text: stats.overview.root_path });
      } else await invoke("open_file_with_system", { path: stats.overview.root_path });
      setFeedback(kind === "copy" ? "数据目录路径已复制" : "已打开数据文件夹");
    } catch { setFeedback(kind === "copy" ? "复制路径失败，请重试。" : "无法打开文件夹，请重试。"); }
  };
  const metric = (value: number | null) => {
    const [number, unit] = value === null ? ["—", ""] : formatStorageBytes(value).split(" ");
    return <><strong>{number}<small className={styles.unit}>{unit}</small></strong></>;
  };
  return <div className={styles.panel} ref={ref}>
    <div className={styles.header}>
      <div><span className={settings.sRowLabel}>存储空间概览</span>
        <p className={styles.headerStatus} role="status">{stats.error || (stats.loading ? "正在统计，可随时停止" : feedback || (stats.overview ? `更新于 ${stats.overview.measured_at}` : "查看时按需读取"))}</p>
        {stats.error && stats.overview && <p className={styles.headerStatus}>保留上次结果：{stats.overview.measured_at}</p>}
      </div>
      <div className={styles.actions}><button className={styles.action} disabled={stats.loading || !stats.active} onClick={() => void stats.refresh()}>{stats.loading ? "统计中…" : "刷新统计"}</button>
        {stats.loading && <button className={styles.action} onClick={() => { stats.cancel(); setFeedback("统计已停止，保留已读取结果。"); }}>停止统计</button>}</div>
    </div>
    <div className={styles.metrics} aria-busy={stats.loading}>
      <div className={styles.metric}>{metric(stats.overview?.total_bytes ?? null)}<span>{stats.overview?.complete ? "总占用" : "已统计占用"}</span></div>
      {categories.filter(c => c.key !== "other").map(c => <div key={c.key} className={`${styles.metric} ${styles[c.key]}`}>{metric(c.complete ? c.bytes : null)}<span>{c.label}</span></div>)}
    </div>
    <p className={styles.scope}>全部工作空间共用 · SQLite 数据库、图片与缓存占用</p>
    <StorageCharts categories={categories} complete={stats.overview?.complete ?? false} database={stats.database}
      databaseError={stats.databaseError} loading={stats.loading} />
    <div className={styles.status} role="status">
      {stats.loading ? "正在读取数据库与扫描目录…" : stats.overview
        ? `${stats.overview.complete ? "文件合计" : "已统计文件"} ${formatStorageBytes(stats.overview.total_bytes)} · 更新于 ${stats.overview.measured_at}`
        : "查看时按需读取本机存储占用"}
      {!stats.loading && stats.overview && !stats.overview.complete && <span> · 部分文件无法统计，请刷新重试</span>}
      {stats.stale && <span> · 数据有变化，刷新查看</span>}
      {feedback && <p>{feedback}</p>}
    </div>
    {stats.overview && <div className={styles.pathRow}><b>数据位置</b><code>{stats.overview.root_path}</code>
      <div className={styles.actions}><button className={styles.action} onClick={() => void action("copy")}>复制路径</button><button className={styles.action} onClick={() => void action("open")}>打开文件夹</button></div>
      {/* Directory actions report here too, so their feedback stays visible below the charts. */}
      {feedback && <p className={styles.muted} role="status">{feedback}</p>}
    </div>}
  </div>;
}
