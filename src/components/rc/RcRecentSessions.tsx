/**
 * RcRecentSessions — 详情面「最近会话」5 条。
 *
 * 只读本机 `rc_session_history` 里属于**这台设备**的记录（按 node_id 过滤，
 * 不是按名字——名字会改）。
 *
 * 🔴 条数由 3 改为 5（2026-09-22，对稿 A 布局 × C 样式）：
 *    A 方案「密实化」的主要卖点就是这一块 —— 详情面右栏下部原先是空的，
 *    5 条 × 46px 刚好把它填掉。行高取 46 而不是 C 的 60，因为 5×60 放不进
 *    `detailBody` 的可用高。完整列表仍在记录页，所以右上角保留「查看全部」。
 *
 * 行内三列 = 能力药丸 + 时间 / 时长 / 结果。能力做成药丸是 C 的做法，
 * 只分两档颜色：可控 = 强调色、只看 = 中性 —— 它回答的是「我能不能动」，
 * 不是好坏，所以不上语义色。
 *
 * 结果列的着色（2026-09-22 补）：档位与记录页共用 `@/lib/rcHistory` 的
 * `resultTone`、色号与记录页共用同名 `data-tone` 属性 —— 原先这一列裸用
 * `--text-muted`，导致同一个 `reason` 在记录页是绿的、在这儿是灰的。
 *
 * 稿的这一块还画过「文件传输 · 3 个文件」——**没有做**：`rc_session_history`
 * 只记画面会话（control/view），没有文件传输记录。宁可少一行也不摆假数据。
 */
import type { RcHistoryItem } from "@/lib/api/rc";
import { historyCapabilityLabel, recentSessionsFor, resultTone } from "@/lib/rcHistory";
import { formatDuration, formatWhen, pathKindLabel } from "@/lib/rcSessionStats";
import styles from "./RemoteComputerA2.module.css";

/** 药丸配色只认 control / view 两档，其余一律按「只看」的中性处理。 */
function capTone(capability: string): "control" | "view" {
  return capability === "control" ? "control" : "view";
}

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
  const items = recentSessionsFor(list, peer, 5);
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
            /* 三列放不下路径与延迟，收进 title 补回（同历史页 PageRow 的做法：
               省掉的信息必须有地方补回）。 */
            const path = pathKindLabel(h.path_kind ?? "");
            const rtt = h.rtt_avg && h.rtt_avg > 0 ? h.rtt_avg : 0;
            const hint = [h.reason, path, rtt ? `延迟 ~${rtt}ms` : ""].filter(Boolean).join(" · ");
            return (
              <div key={`${h.started_ms}-${i}`} className={styles.recentLine} title={hint}>
                <span className={styles.recentCap}>
                  <span className={styles.capChip} data-cap={capTone(h.capability)}>
                    {historyCapabilityLabel(h.capability)}
                  </span>
                  <span>{formatWhen(h.started_ms)}</span>
                </span>
                <span className={styles.recentDuration}>{formatDuration(h.duration_ms)}</span>
                <span className={styles.recentResult} data-tone={resultTone(h.reason)}>
                  {h.reason}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
