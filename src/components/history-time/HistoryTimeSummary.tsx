import { historyDateOffset, historyTimeLabel, parseHistoryWindow } from "@/lib/utils";
import styles from "./HistoryTime.module.css";

export function HistoryTimeSummary({ value, count, loading, error }: {
  value: string; count: number | null; loading: boolean; error: string;
}) {
  const range = parseHistoryWindow(value);
  let caption = value === "all" ? "不限日期与时段" : "按所选时间范围筛选";
  if (range) {
    const date = range.start.slice(0, 10), endDate = range.end.slice(0, 10);
    const start = range.start.slice(11, 16), end = range.end.slice(11, 16);
    const nextMidnight = endDate === historyDateOffset(date, 1) && end === "00:00";
    if (date === endDate || nextMidnight) {
      caption = `${date} · ${start === "00:00" && nextMidnight ? "全天" : `${start}–${nextMidnight ? "24:00" : end}`}`;
    } else if (start === "00:00" && end === "00:00") {
      caption = `${date} 至 ${historyDateOffset(endDate, -1)}`;
    } else caption = `${range.start.slice(0, 16)} 至 ${range.end.slice(0, 16)}（不含）`;
  }
  // A refresh failure or pending query must not turn a previous count into a new result.
  const currentCount = loading || error ? null : count;
  // ui-rule-ok: 这是数量摘要；同一面板底部提供“查看全天/查看全部时间”的可执行出口。
  const status = loading ? "正在统计" : error ? "数量未读取" : currentCount === null ? "等待统计" : currentCount === 0 ? "暂无匹配" : "找到记录";
  return <section className={styles.summary} aria-label="当前时间范围" aria-live="polite" aria-atomic="true">
    <div className={styles.summaryRange}><h3>{historyTimeLabel(value)}</h3><p>{caption}</p></div>
    <div className={styles.resultNumber}><small>{status}</small><strong>{currentCount?.toLocaleString() ?? "—"}</strong><span>条</span></div>
  </section>;
}
