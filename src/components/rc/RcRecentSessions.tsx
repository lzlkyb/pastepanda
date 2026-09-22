/**
 * RcRecentSessions — 详情面「最近会话」3 条（批5a，对稿 section-head + history-list）。
 *
 * 只读本机 `rc_session_history` 里属于**这台设备**的记录（按 node_id 过滤，
 * 不是按名字——名字会改）。取 3 条是为了和稿一致：详情面是「一眼确认」的位置，
 * 完整列表在记录页，所以右上角带「查看全部」。
 *
 * 稿的第 3 行画的是「文件传输 · 3 个文件」——**没有做**：`rc_session_history`
 * 只记画面会话（control/view），没有文件传输记录。宁可少一行也不摆假数据，
 * 这条已写进设计稿实施备注。
 */
import type { RcHistoryItem } from "@/lib/api/rc";
import { historyCapabilityLabel, recentSessionsFor } from "@/lib/rcHistory";
import { formatDuration, formatWhen, pathKindLabel } from "@/lib/rcSessionStats";
import styles from "./RemoteComputerA2.module.css";

export function RcRecentSessions({
  list,
  peer,
  onViewAll,
}: {
  list: RcHistoryItem[];
  /** 当前选中设备的 node_id。 */
  peer: string | null;
  onViewAll: () => void;
}) {
  const items = recentSessionsFor(list, peer, 3);
  return (
    <section className={styles.recentBlock} aria-label="最近会话">
      <div className={styles.sectionHead}>
        <h3>最近会话</h3>
        <button type="button" className={styles.sectionLink} onClick={onViewAll}>
          查看全部
        </button>
      </div>
      {items.length === 0 ? (
        <p className={styles.recentEmpty}>这台设备还没有会话记录。</p>
      ) : (
        <div className={styles.recentList}>
          {items.map((h, i) => {
            /* 四列放不下路径与延迟，收进 title 补回（同历史页 PageRow 的做法：
               省掉的信息必须有地方补回）。 */
            const path = pathKindLabel(h.path_kind ?? "");
            const rtt = h.rtt_avg && h.rtt_avg > 0 ? h.rtt_avg : 0;
            const hint = [h.reason, path, rtt ? `延迟 ~${rtt}ms` : ""].filter(Boolean).join(" · ");
            return (
              <div key={`${h.started_ms}-${i}`} className={styles.recentLine} title={hint}>
                <strong>{historyCapabilityLabel(h.capability)}</strong>
                <span>{formatDuration(h.duration_ms)}</span>
                <span>{formatWhen(h.started_ms)}</span>
                <span className={styles.recentResult}>{h.reason}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
