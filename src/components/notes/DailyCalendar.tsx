/**
 * 侧栏月历（B2 #3 / D11）。设计稿 §1。
 *
 * **只在选中「今日速记」时展开**，不常驻：侧栏只有 180px（与记录模式
 * Sidebar 同宽，不能为它加宽），一个月历要吃掉约 120px 高，
 * 常驻就把文件夹树挤到屏幕下半截。
 *
 * 日期计算全在 `@/lib/dailyCalendar`（纯函数，已钉用例），
 * 这里只管画和点。
 *
 * 🔴 红线：无 AI。
 */
import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { canGoNext, canGoPrev, monthGrid, monthOf } from "@/lib/dailyCalendar";
import styles from "./DailyCalendar.module.css";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

export function DailyCalendar({
  monthKey,
  marked,
  today,
  selected,
  earliest,
  onMonth,
  onPick,
}: {
  /** 当前展示的月，`YYYY-MM` */
  monthKey: string;
  /** 有速记的日期（本月），打蓝点用 */
  marked: Set<string>;
  /** 今天，`YYYY-MM-DD` */
  today: string;
  /** 当前查看的那天；null = 看全部速记 */
  selected: string | null;
  /** 最早一条速记的日期，决定「‹」什么时候置灰 */
  earliest: string | null;
  onMonth: (delta: number) => void;
  onPick: (date: string) => void;
}) {
  const cells = useMemo(() => monthGrid(monthKey), [monthKey]);
  const [y, m] = monthKey.split("-");
  const prevOk = canGoPrev(monthKey, earliest);
  const nextOk = canGoNext(monthKey, today);

  return (
    <div className={styles.cal}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.nav}
          onClick={() => onMonth(-1)}
          disabled={!prevOk}
          title={prevOk ? "上一月" : "再往前没有速记了"}
          aria-label="上一月"
        >
          <ChevronLeft size={12} />
        </button>
        <b>
          {y} 年 {Number(m)} 月
        </b>
        <button
          type="button"
          className={styles.nav}
          onClick={() => onMonth(1)}
          disabled={!nextOk}
          title={nextOk ? "下一月" : "未来还没有速记"}
          aria-label="下一月"
        >
          <ChevronRight size={12} />
        </button>
      </div>

      <div className={styles.grid}>
        {WEEK.map((w) => (
          <span key={w} className={styles.wd}>
            {w}
          </span>
        ))}
        {cells.map((c) => {
          const cls = [
            styles.day,
            c.inMonth ? "" : styles.dim,
            marked.has(c.date) ? styles.has : "",
            c.date === today ? styles.today : "",
            c.date === selected ? styles.sel : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={c.date}
              type="button"
              className={cls}
              /* 没速记的日期也能点（进去是空态）——禁掉会让人以为日历坏了，
                 而且点今天的空态正是把热键教给用户的地方 */
              onClick={() => onPick(c.date)}
              title={marked.has(c.date) ? `${c.date} 有速记` : c.date}
            >
              {c.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 默认展示哪个月：选中了某天就看那个月，否则看今天所在月。 */
export function initialMonth(selected: string | null, today: string): string {
  return monthOf(selected ?? today);
}
