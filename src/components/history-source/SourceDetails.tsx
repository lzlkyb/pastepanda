import { File, Image, Layers, Text } from "lucide-react";
import type { HistorySourceEntry, SourceMetrics } from "@/lib/api/historySource";
import { SourceIdentity } from "./SourceIdentity";
import styles from "./HistorySource.module.css";

export function SourceDetails({ entry, metrics, total, preview }: {
  entry?: HistorySourceEntry; metrics: SourceMetrics; total: number; preview: boolean;
}) {
  const types = [
    { name: "文本", count: metrics.text_count, Icon: Text },
    { name: "图片", count: metrics.image_count, Icon: Image },
    { name: "文件", count: metrics.file_count, Icon: File },
  ];
  return <section className={styles.details} aria-label="来源内容详情" aria-live="polite">
    <div className={styles.detailTitle}><b>{preview && <span className={styles.previewLabel}>预览 ·</span>}
      {entry ? <SourceIdentity source={entry.source} sourceIcon={entry.source_icon} /> : <><Layers size={16} />全部来源</>}</b>
      <span>{metrics.count.toLocaleString()} 条 · {entry ? `${Math.round(metrics.count / (total || 1) * 100)}%` : "当前范围"}</span></div>
    <div className={styles.typeCounts}>{types.map(({ name, count, Icon }) => <div key={name} className={styles.typeMetric}>
      <Icon size={14} /><span>{name}</span><strong>{count.toLocaleString()}</strong>
    </div>)}</div>
    <div className={styles.latest}><span>最近一条 <time>{metrics.latest_time ? metrics.latest_time.replace(/\.\d+$/, "").slice(0, 16) : "未记录时间"}</time></span><span>{preview ? "移开恢复已选" : "当前范围内统计"}</span></div>
    {metrics.other_count > 0 && <p className={styles.other}>其他类型 {metrics.other_count.toLocaleString()} 条</p>}
  </section>;
}
