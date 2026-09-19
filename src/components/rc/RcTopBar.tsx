/**
 * RcTopBar — 工作台玻璃顶栏（v4 布局，2026-09-19）。
 *
 * 左：页面标题 + 副标题（名词唯一来源 `WB_PAGE_META`——导航项与顶栏念同一名词）。
 * 右：通道状态 chip + 会话进行中 chip + 设置图标钮。
 *
 * chip 可点：通道未启动时点它 = `rc_start_channel`（原侧栏 noteWarn 里那个按钮的
 * 接线语义原样搬来）。已启动时 chip 不可点（停止通道原实现就没有入口，不新增）。
 *
 * 会话 chip 只报状态不摆动作：断开/申请控制权在会话视图与底栏里各有一份
 * （见 MEMORY-rc「文件归属」表），顶栏再放一个「断开」就是第三个危险入口。
 *
 * v4 补差（2026-09-19 第二轮对稿）：①右侧补「设置」齿轮钮——稿里它是设置页的
 * 顶栏入口，等价于导航第四项，不发明任何后端；②hint 支持覆盖——设备列表页
 * 念「共 N 台 · M 台在线」（稿 C 窗），其余页沿用静态 meta。
 *
 * v4 补差（2026-09-19 第三轮对稿）：③actions 插槽——稿 C 窗的顶栏右侧是
 * 「检测在线 + 配对设备」，原先这两个动作被摆在了内容区搜索行里。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Radio, Settings } from "lucide-react";
import type { WbPage } from "@/lib/rcWorkbench";
import { WB_PAGE_META } from "@/lib/rcWorkbench";
import { formatDuration } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

export function RcTopBar({
  page,
  channelUp,
  busy,
  sessionLabel,
  hintOverride,
  actions,
  sessionStartedMs,
  onStartChannel,
  onOpenSettings,
}: {
  page: WbPage;
  /** 远程通道是否在跑（`rc_status.running`）。 */
  channelUp: boolean;
  busy: boolean;
  /** 会话进行中时的一行状态（「正在远程控制 X · 只看」）；空 = 不摆。 */
  sessionLabel: string;
  /** 覆盖默认副标题（如设备列表页的动态计数）；不传用 WB_PAGE_META。 */
  hintOverride?: string;
  /** 页签级动作（稿 C 窗：设备列表页的「检测在线 / 配对设备」）；不传不占位。 */
  actions?: ReactNode;
  /** 会话开始时间（session.started_ms）。给了就在 chip 里带每秒走字的时长。 */
  sessionStartedMs?: number;
  onStartChannel: () => void;
  /** 顶栏齿轮的去处（工作台内 = 导航设置页）。 */
  onOpenSettings: () => void;
}) {
  const meta = WB_PAGE_META[page];
  return (
    <header className={styles.topBar}>
      <h1 className={styles.tbTitle}>
        {meta.title}
        <span className={styles.tbHint}>{hintOverride ?? meta.hint}</span>
      </h1>
      <span className={styles.tbSp} />
      {/* v5 组合状态胶囊（设计稿原则③）：通道与会话同住一条，细分隔线分格，
          替代原先并排的两颗独立 chip。通道未启动段可点 = 启动通道。 */}
      <span className={styles.tbGroup} role="group" aria-label="远程状态">
        {channelUp ? (
          <span className={styles.tbCellOn}>
            <span className={styles.tbDot} aria-hidden="true" />
            通道已开启
          </span>
        ) : (
          <button
            type="button"
            className={styles.tbCellOff}
            disabled={busy}
            title="启动远程通道后才能发起或接受远程会话"
            onClick={onStartChannel}
          >
            <span className={`${styles.tbDot} ${styles.tbDotPulse}`} aria-hidden="true" />
            通道未启动 · 点击开启
          </button>
        )}
        {sessionLabel && (
          <span className={styles.tbCellSess}>
            {/* live region 只包状态文字；每秒走字的时长在外面 aria-hidden——
                与 RcControlBanner 的计时器同一纪律（否则 SR 每秒播报）。 */}
            <span role="status">
              <Radio size={12} aria-hidden="true" />
              {sessionLabel}
            </span>
            {sessionStartedMs != null && <ChipTimer startedMs={sessionStartedMs} />}
          </span>
        )}
      </span>
      {actions}
      <button
        type="button"
        className={styles.icoBtn}
        aria-label="工作台设置"
        title="工作台设置"
        onClick={onOpenSettings}
      >
        <Settings size={15} aria-hidden="true" />
      </button>
    </header>
  );
}

/** chip 内每秒走字的会话时长。纯视觉（aria-hidden），不进 live region。 */
function ChipTimer({ startedMs }: { startedMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span aria-hidden="true" className={styles.tbTimer}> · {formatDuration(now - startedMs)}</span>;
}
