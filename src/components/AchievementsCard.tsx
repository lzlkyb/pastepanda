/**
 * AchievementsCard —— 成就墙（v6.8 粘性 A3）。
 *
 * 真实成就导向：每个成就对应一个深度功能或长期积累（见 lib/achievements.ts），
 * 不奖励虚荣指标。判定基于 `stats_sticky` 本地聚合，零出网、零内容。
 *
 * 嵌入 ProfileDialog；独立子组件守卫 300 行规则。
 */
import { useEffect, useState } from "react";
import { statsSticky, type StickyStats } from "@/lib/api/sticky";
import { ACHIEVEMENTS, unlockedIds, unlockedCount } from "@/lib/achievements";
import styles from "./AchievementsCard.module.css";

export function AchievementsCard() {
  const [stats, setStats] = useState<StickyStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    void statsSticky()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        /* 拉不到就不显示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) return null;

  const unlocked = unlockedIds(stats);
  const count = unlockedCount(stats);
  const total = ACHIEVEMENTS.length;
  const pct = Math.round((count / total) * 100);

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>
        <span className={styles.dot} style={{ background: "#f5a623" }} />
        成就墙
        <span className={styles.badgeNew}>NEW</span>
        <span className={styles.meta}>
          {count} / {total} 已解锁
        </span>
      </div>

      <div className={styles.grid}>
        {ACHIEVEMENTS.map((a) => {
          const on = unlocked.has(a.id);
          return (
            <div key={a.id} className={`${styles.ach} ${on ? "" : styles.un}`} title={on ? a.desc : a.hint(stats)}>
              <div className={`${styles.icon} ${on ? styles.on : ""}`}>{a.icon}</div>
              <div className={styles.name}>{a.name}</div>
              <div className={styles.desc}>{a.desc}</div>
            </div>
          );
        })}
      </div>

      <div className={styles.foot}>
        <div className={styles.prog}>
          <div className={styles.progBg}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.progTxt}>{total} 个成就 · 已解锁 {count} 个</span>
        </div>
      </div>
    </div>
  );
}
