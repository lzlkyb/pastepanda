/**
 * QuotaEntryCard —— 设置 → AI 页的免费额度只读卡（v6.9）。
 *
 * 只读入口：余额条 + 「去签到/兑换」按钮 → 打开 QuotaDialog。
 * 完整签到阶梯在 QuotaDialog 里，这里不重复（保持设置页紧凑）。
 * 与自配服务商隔离：无论当前用哪家，这里只展示免费额度状态。
 */
import { useEffect, useState } from "react";
import { Gift } from "lucide-react";
import { aiQuotaGet, type QuotaInfo } from "@/lib/api/quota";
import { useDialogStore } from "@/stores/dialogStore";
import { fmtWan } from "@/lib/quota";
import styles from "./QuotaEntryCard.module.css";

export function QuotaEntryCard() {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void aiQuotaGet()
      .then((q) => {
        if (!cancelled) setQuota(q);
      })
      .catch(() => {
        /* 拉不到就不显示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!quota) return null;

  const usedPct = quota.granted + quota.spent > 0
    ? Math.min(100, Math.round((quota.spent / (quota.granted + quota.spent)) * 100))
    : 0;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.icon}><Gift size={12} /></span>
        免费额度
        <span className={styles.sub}>内置 Agnes · 与自配服务商隔离</span>
      </div>
      <div className={styles.body}>
        <div className={styles.info}>
          <div className={styles.title}>
            剩余 <b>{fmtWan(quota.remaining)}</b>
            {quota.canSign && <span className={styles.canSign}>今日可签到</span>}
          </div>
          <div className={styles.bar}>
            <div className={styles.barFill} style={{ width: `${Math.max(2, usedPct)}%` }} />
          </div>
          <div className={styles.meta}>
            已用 {fmtWan(quota.spent)} · 今日已用 {fmtWan(quota.todaySpent)}
          </div>
        </div>
        <button className={styles.btn} onClick={() => useDialogStore.getState().openQuota()}>
          去签到 / 兑换
        </button>
      </div>
    </div>
  );
}
