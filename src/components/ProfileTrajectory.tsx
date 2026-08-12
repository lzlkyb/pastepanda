/**
 * ProfileTrajectory —— 我的轨迹（v6.8 粘性 A2）：活跃日历 + 连续周数。
 *
 * 数据来自 `stats_sticky`（本地聚合，不含内容）：
 * - 最近 12 周逐日活跃（颜色深浅 = 当天操作量，0 = 无活跃）
 * - 连续活跃周数（周粒度 streak，带宽限的"老兵不死"前身）
 *
 * 嵌入 ProfileDialog 角色区之后；主文件保持 ≤300 行，独立子组件。
 */
import { useEffect, useState } from "react";
import { statsSticky, type CalendarDay, type StickyStats } from "@/lib/api/sticky";
import styles from "./ProfileTrajectory.module.css";

/** 活跃度分档（0=无，1-4 由浅到深） */
function level(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 6) return 2;
  if (count <= 15) return 3;
  return 4;
}

/** 84 天 → 12 周块（每块 7 天，从旧到新） */
function chunkWeeks(calendar: CalendarDay[]): CalendarDay[][] {
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < 12; i++) {
    weeks.push(calendar.slice(i * 7, i * 7 + 7));
  }
  return weeks;
}

export function ProfileTrajectory() {
  const [stats, setStats] = useState<StickyStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    void statsSticky()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        /* 统计拉不到就不显示，不打扰画像主流程 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) return null;

  const weeks = chunkWeeks(stats.calendar);
  const today = stats.calendar[stats.calendar.length - 1]?.date;

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>
        <span className={styles.dot} style={{ background: "#38e1d4" }} />
        我的轨迹
        <span className={styles.badgeNew}>NEW</span>
        <span className={styles.meta}>最近 12 周 · 行为统计</span>
      </div>

      <div className={styles.trajTop}>
        <div className={styles.calLabel}>
          活跃日历 <span className={styles.calHint}>颜色越深 = 当天操作越多</span>
        </div>
        <span className={styles.streak}>
          <i>🔥</i> 连续活跃 {stats.activeWeekStreak} 周
        </span>
      </div>

      <div className={styles.cal}>
        {weeks.map((week, wi) => (
          <div key={wi} className={styles.calCol}>
            {week.map((d) => {
              const lv = level(d.count);
              const isToday = d.date === today;
              return (
                <div
                  key={d.date}
                  title={d.date}
                  className={`${styles.calDay} ${lv > 0 ? styles[`d${lv}`] : ""} ${isToday ? styles.today : ""}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className={styles.trajMeta}>
        <div className={styles.legend}>
          <i className={styles.l0} /><span>少</span>
          <i className={styles.l1} />
          <i className={styles.l2} />
          <i className={styles.l3} />
          <i className={styles.l4} /><span>多</span>
        </div>
        <div>
          近 12 周活跃 {stats.activeDays} 天 · 平均每周{" "}
          {(stats.activeDays / 12).toFixed(1)} 天
        </div>
      </div>
    </div>
  );
}
