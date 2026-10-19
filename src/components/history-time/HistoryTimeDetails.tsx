import { useHistoryTimeDistribution } from "@/hooks/useHistoryTimeDistribution";
import { cleanSourceName, historyTimeLabel, historyTimeWindow } from "@/lib/utils";
import { HistoryHours } from "./TimeDistributionCharts";
import styles from "./HistoryTime.module.css";

export function HistoryTimeDetails({ open, day, previewDay, value, stats, onChoose }: {
  open: boolean; day: string; previewDay: string | null; value: string;
  stats: ReturnType<typeof useHistoryTimeDistribution>;
  onChoose: (date: string, start: number, end: number) => void;
}) {
  const date = previewDay ?? day;
  // Preview requests have their own cancellation/snapshot, so the selected result count stays stable.
  const preview = useHistoryTimeDistribution(open && previewDay !== null, date);
  const detail = previewDay !== null ? preview : stats;
  const ready = detail.data?.selected_date === date;
  const failedPreview = previewDay !== null && !!detail.error;
  const count = ready ? detail.data!.hours.reduce((sum, n) => sum + n, 0) : stats.data?.days.find(d => d.date === date)?.count;
  const sources = [...new Set(detail.data?.sources.map(s => cleanSourceName(s.source) || "未知来源") ?? [])].slice(0, 3);
  return <section className={styles.detailSection} aria-label="日期时段详情">
    <div className={styles.sectionHeading}><b>{previewDay !== null ? "预览 · " : ""}{historyTimeLabel(historyTimeWindow(date))}</b><small>{count === undefined ? "" : `共 ${count} 条`}</small></div>
    <div className={styles.detailBody}>
      {ready && !failedPreview ? <>
        <HistoryHours hours={detail.data!.hours} value={value} day={date} onChoose={(start, end) => onChoose(date, start, end)} />
        <p className={styles.hint}>{sources.length ? `主要来源：${sources.join("、")}` : "当天没有符合当前筛选条件的记录，可选择其他日期。"}</p>
      </> : <p className={styles.detailPlaceholder} role="status">{failedPreview ? "预览读取失败，移开后重新悬停可重试。" : detail.error ? "该日期的时段分布尚未读取成功，请重新读取。" : previewDay !== null ? "正在读取预览时段…" : "正在读取所选日期的时段…"}</p>}
    </div>
  </section>;
}
