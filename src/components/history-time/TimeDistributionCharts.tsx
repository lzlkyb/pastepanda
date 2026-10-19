import { useId } from "react";
import { Check, Moon, Sun, Sunrise } from "lucide-react";
import type { HistoryTimeDistribution } from "@/lib/api/historyTime";
import { historyTimeLabel, historyTimeWindow } from "@/lib/utils";
import styles from "./HistoryTime.module.css";

export function HistoryDays({ days, selectedDate, selected, previewDate, onPreview, onChoose }: {
  days: HistoryTimeDistribution["days"]; selectedDate: string; selected: boolean; onChoose: (day: string) => void;
  previewDate: string | null; onPreview: (day: string | null) => void;
}) {
  const max = Math.max(...days.map(d => d.count), 1);
  const gradient = useId();
  return <div className={styles.days} aria-label="按日期统计的记录数量" onPointerLeave={() => onPreview(null)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onPreview(null); }}>
    <svg className={styles.defs} aria-hidden="true"><defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop className={styles.barStart} /><stop offset="1" className={styles.barEnd} /></linearGradient></defs></svg>
    {days.map(day =>
    <button type="button" key={day.date} className={styles.day} aria-pressed={selected && day.date === selectedDate} data-preview={previewDate === day.date}
      title={`${day.date} · ${day.count} 条 · 点击筛选当天`} aria-label={`${day.date}，${day.count} 条记录`}
      onPointerEnter={event => { if (event.pointerType !== "touch") onPreview(day.date); }} onFocus={() => onPreview(day.date)} onClick={() => onChoose(day.date)}>
      <svg viewBox="0 0 20 64" preserveAspectRatio="none" aria-hidden="true"><rect fill={selected && day.date === selectedDate ? `url(#${gradient})` : undefined} x="3" width="14" rx="3" y={64 - day.count / max * 60} height={day.count / max * 60} /></svg>
      <span>{Number(day.date.slice(8, 10))}</span>
    </button>)}</div>;
}

export function HistoryHours({ hours, value, day, onChoose }: {
  hours: number[]; value: string; day: string; onChoose: (start: number, end: number) => void;
}) {
  const pairs = Array.from({ length: 12 }, (_, i) => (hours[i * 2] ?? 0) + (hours[i * 2 + 1] ?? 0));
  const max = Math.max(...pairs, 1);
  const selected = historyTimeLabel(value);
  return <>
    <div className={styles.slots}>{[
      { from: 0, to: 12, label: "上午", Icon: Sunrise }, { from: 12, to: 18, label: "下午", Icon: Sun }, { from: 18, to: 24, label: "晚上", Icon: Moon },
    ].map(({ from, to, label, Icon }) => {
      const active = value === historyTimeWindow(day, from, to);
      const count = hours.slice(from, to).reduce((sum, n) => sum + n, 0);
      return <button type="button" key={label} aria-label={`${label}，${count} 条记录`} aria-pressed={active} onClick={() => onChoose(from, to)}>
        <div className={styles.slotHeading}><Icon size={16} /><b>{label}</b>{active && <Check size={12} className={styles.slotCheck} />}</div>
        <strong className={styles.slotCount}>{count.toLocaleString()}<small>条</small></strong><span className={styles.slotRange}>{String(from).padStart(2, "0")}:00–{to}:00</span>
      </button>;
    })}</div>
    <div className={styles.preciseLabel}>精确到时段<span>每格 2 小时 · 点击筛选</span></div>
    <div className={styles.hours} aria-label="按两小时时段筛选">{pairs.map((count, i) => {
      const hour = i * 2;
      const active = value === historyTimeWindow(day, hour, hour + 2)
        || (value === historyTimeWindow(day, 0, 12) && hour < 12)
        || (value === historyTimeWindow(day, 12, 18) && hour >= 12 && hour < 18)
        || (value === historyTimeWindow(day, 18, 24) && hour >= 18);
      return <button type="button" key={hour} aria-pressed={active} title={`${hour}:00–${hour + 2}:00 · ${count} 条`}
        aria-label={`${hour} 点至 ${hour + 2} 点，${count} 条记录`} onClick={() => onChoose(hour, hour + 2)}>
        <svg viewBox="0 0 20 36" preserveAspectRatio="none" aria-hidden="true"><rect x="3" width="14" rx="2" y={36 - count / max * 34} height={count / max * 34} /></svg>
        <span>{String(hour).padStart(2, "0")}</span>
      </button>;
    })}</div>
    <span className={styles.srOnly}>当前范围：{selected}</span>
  </>;
}
