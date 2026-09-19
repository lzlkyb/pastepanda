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
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import {
  rcSessionHistory,
  type RcCapability,
  type RcHistoryItem,
  type RcTargetDevice,
} from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import { canReconnectTo } from "@/lib/rcDevice";
import { capabilityLabel } from "@/lib/rcRequest";
import { formatDuration, formatWhen, pathKindLabel } from "@/lib/rcSessionStats";
// D10：历史记录用 rc 会话专用的 hist* 类，不再复用「局域网同步」的 lanDevice* 类
import styles from "./RemoteComputer.module.css";

/** 结果列的四态着色。reason 是后端的自由中文串（「用户结束会话」…），不是枚举
 * ——所以这里只**按关键词给色**、文本原样展示：把「远程通道关闭」硬翻成
 * 「正常结束」才是造假。 */
function resultTone(reason: string): "ok" | "warn" | "cancel" | "err" {
  if (/取消/.test(reason)) return "cancel";
  if (/拒绝/.test(reason)) return "warn";
  if (/失败|错误|异常/.test(reason)) return "err";
  return "ok";
}

type DirFilter = "all" | "outbound" | "inbound";

export function RcSessionHistory({
  targets,
  running,
  busy,
  onReconnect,
  variant = "compact",
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
}) {
  const [list, setList] = useState<RcHistoryItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dir, setDir] = useState<DirFilter>("all");

  useEffect(() => {
    void rcSessionHistory()
      .then(setList)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const shown = useMemo(() => {
    if (variant !== "page" || dir === "all") return list;
    return list.filter((h) => h.dir === dir);
  }, [list, dir, variant]);

  /** 时长总计（稿 D 窗 pageBar 右侧）。 */
  const totalMs = useMemo(
    () => shown.reduce((acc, h) => acc + (h.duration_ms ?? 0), 0),
    [shown],
  );

  if (loading) {
    return <div className={styles.histNote}>加载中…</div>;
  }
  if (err) {
    return <div className={styles.histNoteErr}>读取会话历史失败：{err}</div>;
  }
  if (list.length === 0) {
    return (
      <div className={styles.histNote}>
        暂无会话记录。开始一次远程后会出现在这里（只记元数据）。
      </div>
    );
  }

  if (variant === "page") {
    const dirCount = (d: DirFilter) =>
      d === "all" ? list.length : list.filter((h) => h.dir === d).length;
    return (
      <div className={styles.pageHist}>
        <div className={styles.searchRow}>
          <div className={styles.filterRow} role="group" aria-label="按方向筛选">
            {(
              [
                ["all", "全部"],
                ["outbound", "出站"],
                ["inbound", "入站"],
              ] as [DirFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`${styles.fPill} ${dir === key ? styles.fPillOn : ""}`}
                aria-pressed={dir === key}
                onClick={() => setDir(key)}
              >
                {label} {dirCount(key)}
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
      </div>
    );
  }

  return (
    <div className={styles.histList}>
      {list.map((h, i) => {
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
        const peerLabel = h.peer_name || fingerprintOf(h.peer);
        return (
          <div key={`${h.started_ms}-${i}`} className={styles.histItem}>
            <div className={styles.histInfo}>
              <div className={styles.histName}>
                {peerLabel}
                <span className={styles.histNameMeta}>
                  {h.dir === "outbound" ? "我发起" : "对方控我"} ·{" "}
                  {h.capability === "control" ? "可控" : "只看"}
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
                title={`将以「${capabilityLabel(cap)}」再次发起（沿用这次会话用过的档）`}
                onClick={() => onReconnect(h.peer, peerLabel, cap)}
              >
                再次连接
              </button>
            )}
          </div>
        );
      })}
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
  const peerLabel = h.peer_name || fingerprintOf(h.peer);
  const canRetry = canReconnectTo(targets, h.peer, running);
  const path = pathKindLabel(h.path_kind ?? "");
  const rtt = h.rtt_avg && h.rtt_avg > 0 ? h.rtt_avg : 0;
  const tone = resultTone(h.reason);
  const resCls =
    tone === "ok"
      ? styles.phOk
      : tone === "warn"
        ? styles.phWarn
        : tone === "err"
          ? styles.phErr
          : styles.phCancel;
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
        <span className={styles.tagRc}>{h.capability === "control" ? "可控" : "只看"}</span>
      </span>
      <span className={styles.phDur}>{formatDuration(h.duration_ms)}</span>
      <span className={styles.phTime}>{formatWhen(h.started_ms)}</span>
      {/* v5：结果图标退化成状态点（.phRes::before，颜色随语义类），文字自足 */}
      <span className={`${styles.phRes} ${resCls}`}>{h.reason}</span>
      {canRetry && (
        <button
          type="button"
          className={styles.linkBtn}
          disabled={busy}
          title={`将以「${capabilityLabel(cap)}」再次发起（沿用这次会话用过的档）`}
          onClick={() => onReconnect(h.peer, peerLabel, cap)}
        >
          再次连接
        </button>
      )}
    </div>
  );
}
