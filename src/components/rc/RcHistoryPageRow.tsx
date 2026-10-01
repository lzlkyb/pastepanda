/**
 * RcHistoryPageRow — 工作台「会话记录」页的五列单行（v4 稿 D 窗形态）。
 *
 * 从 `RcSessionHistory` 拆出：那个文件同时养 compact / page 两套渲染，加上
 * 设置页折叠组的 `limit` 后越过单文件 300 行线（规则 7）。page 变体的行是本
 * 文件唯一使用者，列宽与着色都只在这套语义里成立，拆出来比拆 compact 行更
 * 干净——compact 行还要和「展开全部」的截断口径共用变量。
 */
import { rcCapTone } from "@/lib/rcCapability";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { RcCapability, RcHistoryItem, RcTargetDevice } from "@/lib/api/rc";
import { canReconnectTo } from "@/lib/rcDevice";
import { historyCapabilityLabel, historyPeerLabel, resultTone } from "@/lib/rcHistory";
import { capabilityLabel } from "@/lib/rcRequest";
import { formatDuration, formatWhen, pathKindLabel } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

export function RcHistoryPageRow({
  h,
  targets,
  running,
  busy,
  onReconnect,
}: {
  h: RcHistoryItem;
  targets: RcTargetDevice[];
  running: boolean;
  busy: boolean;
  onReconnect: (nodeId: string, name: string, cap: RcCapability) => void;
}) {
  const cap = rcCapTone(h.capability);
  const peerLabel = historyPeerLabel(h);
  const canRetry = canReconnectTo(targets, h.peer, running);
  const path = pathKindLabel(h.path_kind ?? "");
  const rtt = h.rtt_avg && h.rtt_avg > 0 ? h.rtt_avg : 0;
  const tone = resultTone(h.reason);
  return (
    <div
      className={styles.histRow}
      title={path || rtt ? `${h.reason}${path ? ` · ${path}` : ""}${rtt ? ` · 延迟 ~${rtt}ms` : ""}` : undefined}
    >
      {/* v5 方向 icon-chip（设计稿 D 窗）：出站 ↗ / 入站 ↘，扫一眼即知方向 */}
      <span className={h.dir === "outbound" ? styles.dirPillOut : styles.dirPillIn}>
        {h.dir === "outbound" ? (
          <ArrowUpRight size={10} aria-hidden="true" />
        ) : (
          <ArrowDownRight size={10} aria-hidden="true" />
        )}
        {h.dir === "outbound" ? "出站" : "入站"}
      </span>
      <span className={styles.phName}>
        {peerLabel}
        <span className={styles.tagRc}>{historyCapabilityLabel(h.capability)}</span>
      </span>
      <span className={styles.phDur}>{formatDuration(h.duration_ms)}</span>
      <span className={styles.phTime}>{formatWhen(h.started_ms)}</span>
      {/* v5：结果图标退化成状态点（.phRes::before，颜色随 data-tone），文字自足。
          用 data-tone 而非四个语义类：详情面「最近会话」共用同一套色，
          同一个属性名让两处能一眼对上、也不会有「漏配某档」的空档。 */}
      <span className={styles.phRes} data-tone={tone}>{h.reason}</span>
      {canRetry && (
        <button
          type="button"
          className={styles.linkBtn}
          disabled={busy}
          title={`沿用这次会话用过的档，再次发起`}
          onClick={() => onReconnect(h.peer, peerLabel, cap)}
        >
          {/* U6：档位上脸——一键可能直接发「可控」，藏在悬浮提示里不够 */}
          再次连接 · {capabilityLabel(cap)}
        </button>
      )}
    </div>
  );
}
