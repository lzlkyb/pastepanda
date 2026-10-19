import { useId, useState } from "react";
import type { DatabaseUsage, StorageFile } from "@/lib/api/storage";
import { formatStorageBytes, storageTableBytes } from "@/lib/utils";
import { TABLE_LABELS } from "./tableLabels";
import styles from "./Storage.module.css";

export interface StorageCategory { key: StorageFile["category"]; label: string; bytes: number; complete: boolean }
interface Props {
  categories: StorageCategory[];
  complete: boolean;
  database: DatabaseUsage | null;
  databaseError: string;
  loading: boolean;
}

export function StorageCharts({ categories, complete, database, databaseError, loading }: Props) {
  const gradient = useId().replace(/:/g, "");
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const total = categories.reduce((sum, c) => sum + c.bytes, 0);
  const largest = categories.reduce<StorageCategory | null>((best, c) => !best || c.bytes > best.bytes ? c : best, null);
  const selected = categories.find(c => c.key === picked) ?? largest;
  const pct = complete && total > 0 && selected ? selected.bytes / total * 100 : null;
  const circumference = 2 * Math.PI * 42;
  let offset = 0;
  const allTables = database?.tables.filter(t => (storageTableBytes(t) ?? 0) > 0) ?? [];
  const tables = showAll ? allTables : allTables.slice(0, 5);
  const largestTable = tables.length ? storageTableBytes(tables[0]) ?? 0 : 0;

  return (
    <>
      <div className={styles.chartTitle}><span>空间花在哪里</span><small>按文件大小</small></div>
      <div className={styles.composition}>
        <svg className={styles.ring} viewBox="0 0 112 112" role="img"
          aria-label={complete ? categories.map(c => `${c.label} ${formatStorageBytes(c.bytes)}，${total ? (c.bytes / total * 100).toFixed(1) : 0}%`).join("；") : "文件统计未完整，暂不显示占比"}>
          <circle cx="56" cy="56" r="42" className={styles.ringTrack} />
          <g transform="rotate(-90 56 56)">
            {complete && total > 0 && categories.map(c => {
              const arc = c.bytes / total * circumference;
              const start = offset; offset += arc;
              return <circle key={c.key} cx="56" cy="56" r="42" className={`${styles.arc} ${styles[c.key]}`}
                strokeDasharray={`${arc} ${circumference - arc}`} strokeDashoffset={-start}>
                <title>{c.label} · {formatStorageBytes(c.bytes)}</title>
              </circle>;
            })}
          </g>
          <text x="56" y="53" textAnchor="middle" className={styles.ringValue}>{pct === null ? "—" : `${pct.toFixed(0)}%`}</text>
          <text x="56" y="70" textAnchor="middle" className={styles.ringLabel}>{complete ? selected?.label ?? "无文件" : loading ? "统计中" : "未完整"}</text>
        </svg>
        <div className={styles.legend}>
          {categories.map(c => <button type="button" key={c.key} className={styles.legendItem} onClick={() => setPicked(c.key)} aria-pressed={selected?.key === c.key}>
            <i aria-hidden="true" className={`${styles.dot} ${styles[c.key]}`} />
            <span>{c.label}</span><b>{c.complete ? formatStorageBytes(c.bytes) : "未统计"}</b>
            <span className={styles.percentage}>{complete && total ? `${(c.bytes / total * 100).toFixed(1)}%` : "—"}</span>
          </button>)}
        </div>
      </div>
      <p className={styles.insight} aria-live="polite">{pct === null
        ? "分类统计未完整，暂不计算占比。"
        : `${selected?.label} ${formatStorageBytes(selected?.bytes ?? 0)}，占全部文件的 ${pct.toFixed(1)}%。`}</p>
      <div className={styles.ranking}>
        <div className={styles.chartTitle}><span>{showAll ? "全部占用排行" : "表占用 Top 5"}</span><small>含索引 · 占主库比例</small></div>
        <svg className={styles.defs} aria-hidden="true"><defs><linearGradient id={gradient}><stop stopColor="var(--accent-solid)" /><stop offset="1" stopColor="var(--accent)" /></linearGradient></defs></svg>
        {databaseError && <p className={styles.error}>{databaseError}{database && " 当前图表为上次结果。"}</p>}
        {!database ? <p className={styles.insight}>{databaseError ? "可刷新重试。" : loading ? "正在分析各表占用…" : "尚未读取表占用，请刷新统计。"}</p>
          : !database.size_supported ? <p className={styles.insight}>当前版本暂不支持表占用图表；上方文件占用统计仍可查看。</p>
            : tables.length === 0 ? <p className={styles.insight}>尚无业务表，数据库结构仍可能占用空间。</p>
              : <div className={styles.rankList}>{tables.map((t, i) => {
                const bytes = storageTableBytes(t) ?? 0;
                return <div key={t.name} className={styles.rankItem}>
                  <span className={styles.rankIndex}>{i + 1}</span><span className={styles.rankLabel}>{TABLE_LABELS[t.name] ?? t.name}</span>
                  <svg className={styles.rankBar} viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                    <rect width="100" height="8" rx="4" className={styles.barTrack} />
                    <rect width={largestTable ? bytes / largestTable * 100 : 0} height="8" rx="4" fill={`url(#${gradient})`} />
                  </svg>
                  <span className={styles.rankValue}>{formatStorageBytes(bytes)}</span>
                  <span className={styles.percentage}>{database.page_bytes ? `${(bytes / database.page_bytes * 100).toFixed(1)}%` : "—"}</span>
                </div>;
              })}</div>}
        <div className={styles.rankFooter}><span>{database ? `主库 ${formatStorageBytes(database.page_bytes)}` : "按本机实际占用统计"}</span>
          {allTables.length > 5 && <button type="button" className={styles.action} onClick={() => setShowAll(v => !v)}>{showAll ? "收起排行" : `展开全部 ${allTables.length} 项`}</button>}</div>
      </div>
    </>
  );
}
