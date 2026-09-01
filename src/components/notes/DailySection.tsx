/**
 * 侧栏的「今日速记」区（B2 #3 / D11）：内置项 + 按需展开的月历。
 *
 * **自己拉自己的数据**（打点日期 / 最早日期 / 总数），而不是让 KnowledgeView
 * 多担三个状态再层层传下来：这三样东西只有日历用，抬到父层只会把
 * 编排层弄肿，也会把 FolderTree 的 props 撞成一长串。
 *
 * 🔴 红线：无 AI。
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { noteCountFiltered, noteDailyDates, noteDailyEarliest } from "@/lib/api";
import { fmtDate, monthOf, shiftMonth } from "@/lib/dailyCalendar";
import { DailyCalendar } from "./DailyCalendar";
import styles from "./FolderTree.module.css";

/** 筛选值是不是速记系（`daily` 或 `daily:YYYY-MM-DD`）。 */
export function isDailyFilter(f: string): boolean {
  return f === "daily" || f.startsWith("daily:");
}

/** 从筛选值里取出那一天；`daily`（全部）返回 null。 */
export function dailyFilterDate(f: string): string | null {
  return f.startsWith("daily:") ? f.slice(6) : null;
}

export function DailySection({
  selected,
  onSelect,
  version,
}: {
  selected: string;
  onSelect: (f: string) => void;
  /** 外部数据变了就递增它（追加速记/删笔记后），触发重拉 */
  version: number;
}) {
  // 今天只在挂载时算一次。跨零点后高亮会滞后一拍，但**落库日期以后端为准**
  // （每次追加都现取），不会因为前端没刷新而写错天。
  const [today] = useState(() => fmtDate(new Date()));
  const [month, setMonth] = useState(() => monthOf(today));
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [earliest, setEarliest] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  const on = isDailyFilter(selected);
  const pickedDate = dailyFilterDate(selected);

  // 打点数据只在展开时拉：没展开就拉，等于每次进知识页面都白发一次查询
  useEffect(() => {
    if (!on) return;
    void noteDailyDates(month).then((ds) => setMarked(new Set(ds)));
  }, [on, month, version]);

  useEffect(() => {
    if (!on) return;
    void noteDailyEarliest().then(setEarliest);
  }, [on, version]);

  // 总数常拉（没展开也要显示），但它只是一个 COUNT，代价很小
  useEffect(() => {
    void noteCountFiltered({ folderFilter: "daily" }).then(setCount);
  }, [version]);

  /** 点内置项：回到「全部速记」，并把月历拉回今天所在月 */
  const pickAll = useCallback(() => {
    setMonth(monthOf(today));
    onSelect("daily");
  }, [onSelect, today]);

  return (
    <>
      <div
        className={`${styles.row} ${on ? styles.rowOn : ""}`}
        onClick={pickAll}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && pickAll()}
      >
        <CalendarDays size={10} className={styles.builtinIcon} />
        <span className={styles.name}>今日速记</span>
        <span className={styles.count}>{count}</span>
      </div>

      {on && (
        <DailyCalendar
          monthKey={month}
          marked={marked}
          today={today}
          selected={pickedDate}
          earliest={earliest}
          onMonth={(d) => setMonth((m) => shiftMonth(m, d))}
          onPick={(date) => {
            // 再点一次已选中的那天 = 取消日期筛选、回到全部，
            // 否则选错日期后没有任何路径回到「全部」除了重点标题行
            onSelect(pickedDate === date ? "daily" : `daily:${date}`);
          }}
        />
      )}
    </>
  );
}
