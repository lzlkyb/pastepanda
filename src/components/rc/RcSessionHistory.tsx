/**
 * RcSessionHistory — 最近会话元数据列表（不记画面/键鼠）。
 *
 * A5（2026-09-18）：每条记录加「再次连接」——高频路径原来是「关掉设置 → 开工作台
 * → 在设备列表里找到那台 → 点发起」，同时设备列表可能已经排到别处。
 * 能力档沿用**这条记录当时用的档**（与设备列表「沿用上次」同一语义），
 * 按钮 tooltip 必须写明，不能让「只想看看」的人一键发出可控申请。
 *
 * v4 对稿（2026-09-19，D 窗）：新增 `variant="page"` 五列形态——方向 pill /
 * 设备+模式 / 时长（等宽右对齐）/ 时间 / 结果。工作台「会话记录」页用它；
 * 主窗口设置页空间窄，继续用 compact 单行。数据源同一份 `rc_session_history`，
 * 只是浏览形态不同——两套渲染的取舍写在下方 resultTone 旁。
 *
 * 批5（2026-09-21）：工作台侧栏加了「按设备筛选」，侧栏在 DOM 上不是本组件的
 * 子节点，所以 `peer` 做成**受控**（由 RcWorkbench 持有）；数据也一并上提
 * （`data` 不传时仍自拉，主窗设置页走这条路，不必为它多挂一个 hook）。
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import {
  rcSessionHistory,
  type RcCapability,
  type RcHistoryItem,
  type RcTargetDevice,
} from "@/lib/api/rc";
import { canReconnectTo } from "@/lib/rcDevice";
import {
  filterHistory,
  historyCapabilityLabel,
  historyPeerLabel,
  RC_HISTORY_MAX,
  resultTone,
  type RcHistoryDirFilter,
} from "@/lib/rcHistory";
import { capabilityLabel } from "@/lib/rcRequest";
import { formatDuration, formatWhen, pathKindLabel } from "@/lib/rcSessionStats";
// D10：历史记录用 rc 会话专用的 hist* 类，不再复用「局域网同步」的 lanDevice* 类
import styles from "./RemoteComputer.module.css";

/** 结果列的四态着色见 `@/lib/rcHistory` 的 `resultTone` —— 抽出去是因为详情面
 * 「最近会话」要用同一份判据（原先两处各判一次，同一 `reason` 会一绿一灰）。 */

interface HistorySource {
  list: RcHistoryItem[];
  loading: boolean;
  err: string | null;
}

/** 数据源：外部传了就用外部的；没传才自己拉（主窗设置页）。 */
function useHistorySource(external?: HistorySource): HistorySource {
  const [own, setOwn] = useState<HistorySource>({ list: [], loading: true, err: null });

  useEffect(() => {
    if (external) return;
    void rcSessionHistory()
      .then((list) => setOwn({ list, loading: false, err: null }))
      .catch((e) => setOwn({ list: [], loading: false, err: String(e) }));
  }, [external]);

  return external ?? own;
}

function dirCountOf(list: readonly RcHistoryItem[], peer: string | null, d: RcHistoryDirFilter): number {
  return filterHistory(list, { peer, dir: d }).length;
}

export function RcSessionHistory({
  targets,
  running,
  busy,
  onReconnect,
  variant = "compact",
  data,
  peer = null,
}: {
  /** 当前配对设备列表：判断这条记录的设备是否还在（决定要不要摆「再次连接」）。 */
  targets: RcTargetDevice[];
  /** 远程通道是否在跑（`rc_status.running`）。 */
  running: boolean;
  busy: boolean;
  /** 再次发起。`cap` 取自本条记录（上次用的档）。 */
  onReconnect: (nodeId: string, name: string, cap: RcCapability) => void;
  /** compact = 主窗设置页的单行；page = 工作台历史页的五列（v4 稿 D 窗）。 */
  variant?: "compact" | "page";
  /** 外部数据源（工作台由 `useRcHistory` 提供，与侧栏筛选共享同一份快照）。 */
  data?: HistorySource;
  /** 受控的设备筛选（node_id）。null = 全部设备。只作用于 page 变体。 */
  peer?: string | null;
}) {
  const source = useHistorySource(data);
  const [dir, setDir] = useState<RcHistoryDirFilter>("all");

  const shown = useMemo(
    () => (variant === "page" ? filterHistory(source.list, { peer, dir }) : source.list),
    [source.list, peer, dir, variant],
  );

  /** 时长总计（稿 D 窗 pageBar 右侧）。跟着当前筛查看，不是全局合计。 */
  const totalMs = useMemo(
    () => shown.reduce((acc, h) => acc + (h.duration_ms ?? 0), 0),
    [shown],
  );

  if (source.loading) {
    return <div className={styles.histNote}>加载中…</div>;
  }
  if (source.err) {
    return <div className={styles.histNoteErr}>读取会话历史失败：{source.err}</div>;
  }
  if (source.list.length === 0) {
    return (
      <div className={styles.histNote}>
        暂无会话记录。开始一次远程后会出现在这里（只记元数据）。
      </div>
    );
  }

  if (variant === "page") {
    return (
      <div className={styles.pageHist}>
        <div className={styles.searchRow}>
          <div className={styles.filterRow} role="group" aria-label="按方向筛选">
            {(
              [
                ["all", "全部"],
                ["outbound", "出站"],
                ["inbound", "入站"],
              ] as [RcHistoryDirFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`${styles.fPill} ${dir === key ? styles.fPillOn : ""}`}
                aria-pressed={dir === key}
                onClick={() => setDir(key)}
              >
                {label} {dirCountOf(source.list, peer, key)}
              </button>
            ))}
          </div>
          <span className={styles.tbSp} />
          <span className={styles.meta}>
            时长总计 <b className={styles.timer}>{formatDuration(totalMs)}</b>
          </span>
        </div>
        <div className={styles.listHead} aria-hidden="true">
          <span className={styles.phDir}>方向</span>
          <span>设备 / 模式</span>
          <span className={styles.tbSp} />
          <span className={styles.phDur}>时长</span>
          <span className={styles.phTime}>时间</span>
          <span className={styles.phRes}>结果</span>
        </div>
        {shown.length === 0 ? (
          <div className={styles.histNote}>
            {peer ? "这台设备在当前筛选下没有记录。换个方向档看看。" : "当前筛选下没有记录。"}
          </div>
        ) : (
          <div className={styles.histList}>
            {shown.map((h, i) => (
              <PageRow
                key={`${h.started_ms}-${i}`}
                h={h}
                targets={targets}
                running={running}
                busy={busy}
                onReconnect={onReconnect}
              />
            ))}
          </div>
        )}
        {/* U7：满 20 条时明说「更早的没了」，别让人猜是被删了还是没记 */}
        {source.list.length >= RC_HISTORY_MAX && (
          <div className={styles.histFoot}>
            已到 {RC_HISTORY_MAX} 条上限：仅保留最近 {RC_HISTORY_MAX} 条，更早的记录不再保留。会话数据只存本机。
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className={styles.histList}>
        {source.list.map((h, i) => {
        // 路径与延迟都是「本次**实测**」，缺了就整段不显示。
        // 更早的记录没有这两个字段，不能编默认值——那会变成假信息。
        const path = pathKindLabel(h.path_kind ?? "");
        const rtt = h.rtt_avg && h.rtt_avg > 0 ? h.rtt_avg : 0;
        const rttTitle =
          rtt && h.rtt_max
            ? `本次实测：最快 ${h.rtt_min ?? 0}ms / 平均 ${rtt}ms / 最慢 ${h.rtt_max}ms`
            : undefined;
        // A5：设备还在 + 通道在跑才摆按钮（判据见 lib/rcDevice.canReconnectTo）
        const canRetry = canReconnectTo(targets, h.peer, running);
        const cap: RcCapability = h.capability === "control" ? "control" : "view";
        const peerLabel = historyPeerLabel(h);
        return (
          <div key={`${h.started_ms}-${i}`} className={styles.histItem}>
            <div className={styles.histInfo}>
              <div className={styles.histName}>
                {peerLabel}
                <span className={styles.histNameMeta}>
                  {h.dir === "outbound" ? "我发起" : "对方控我"} · {historyCapabilityLabel(h.capability)}
                </span>
              </div>
              <div className={styles.histTime}>
                {formatWhen(h.started_ms)} · {formatDuration(h.duration_ms)} · {h.reason}
                {path ? ` · ${path}` : ""}
                {rtt ? <span title={rttTitle}> · 延迟 ~{rtt}ms</span> : null}
              </div>
            </div>
            {canRetry && (
              <button
                type="button"
                className={styles.miniBtn}
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
      })}
      </div>
      {/* U7：compact 变体同款截断提示（主窗设置页） */}
      {source.list.length >= RC_HISTORY_MAX && (
        <div className={styles.histFoot}>
          已到 {RC_HISTORY_MAX} 条上限：仅保留最近 {RC_HISTORY_MAX} 条，更早的记录不再保留。会话数据只存本机。
        </div>
      )}
    </div>
  );
}

/** page 变体的单行（五列）。路径/延迟收进 title 悬停——列宽有限，不摆假列。 */
function PageRow({
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
  const cap: RcCapability = h.capability === "control" ? "control" : "view";
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
