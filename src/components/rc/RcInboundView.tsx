/**
 * RcInboundView — 工作台主区的**被控视角**（别人正在远程本机）。
 *
 * 为什么需要它：主区原先只认 `outbound_active`，被控时落到「空闲」分支，
 * 于是用户正被别人控着，屏幕中央写着「在左侧选择一台设备发起远程」——
 * 界面在问他要不要发起，而谁在控、控了多久、对方能做什么、怎么结束，一个字都没有。
 * 被控是用户最需要「看得见、随时能停」的状态，它偏偏是唯一没有信息面的状态。
 *
 * 与 `RcControlBanner` 的分工：横幅在主窗口常驻（人不在工作台时也得看得见，规则 15），
 * 这里是**工作台**里的完整版——横幅只有一行，塞不下指纹/范围/画质/免确认这些核对信息。
 *
 * 被控端不渲染画面：推流方向是「本机 → 对方」，看自己的屏幕没有意义。
 */
import { useEffect, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import { confirmDialog } from "@/lib/confirm";
import { formatDuration } from "@/lib/rcSessionStats";
import { scopeLabelLong } from "@/lib/rcScope";
import { capabilityLabel } from "@/lib/rcRequest";
import { qualityHudLabel } from "@/lib/rcQuality";
import { useRcFile } from "@/hooks/useRcFile";
import type { RcSession } from "@/lib/api/rc";
import { RcFileAskCard } from "./RcFileAsk";
import styles from "./RemoteComputer.module.css";

export function RcInboundView({
  session,
  busy,
  trusted,
  onTrust,
  quality,
  activeQuality,
  captureScope,
  scopeNotice,
  onDismissScopeNotice,
  onEnd,
}: {
  session: RcSession;
  busy: boolean;
  /** 方案 D：对方是否已免确认（它发起时跳过本机确认条）。 */
  trusted: boolean;
  /** A2：就地开启免确认。不传 = 不摆（该设备已被禁止远程本机，deny 优先级更高）。 */
  onTrust?: () => void;
  /** 本机被控编码档（auto / uhd / …）。 */
  quality: string;
  /** auto 时**实际生效**的档——被控端是推流那台，所以这里拿得到真值。 */
  activeQuality?: string;
  captureScope: string;
  /** 对端刚改成的画面范围；null = 无待展示变更。 */
  scopeNotice?: string | null;
  onDismissScopeNotice?: () => void;
  onEnd: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [session.id]);

  const canControl = session.capability === "control";
  const name = session.peer_name || fingerprintOf(session.peer);

  // G6：文件请求的**完整卡片**（工作台这一份）。主窗常驻横幅那份是一行版，
  // 两者渲染同一份状态；这里多摆指纹 + 文件名 + 大小，因为工作台是用户
  // 「做判断的地方」——核对信息比省版面重要。
  const file = useRcFile(session.peer);

  const endWithConfirm = async () => {
    const ok = await confirmDialog({
      title: "结束远程会话",
      message: `将断开与「${name}」的连接。对方会立刻失去画面与控制。`,
      confirmText: "结束会话",
      variant: "danger",
    });
    if (ok) onEnd();
  };

  return (
    <div className={styles.ibShell}>
      <div className={styles.ibCard}>
        {/* live region 只包状态本身，不包每秒刷新的计时器（否则屏幕阅读器每秒播报一次） */}
        <div className={styles.ibHead} role="status" aria-live="polite">
          <span className={styles.dotDanger} />
          <span className={styles.ibTitle}>
            正在被「<b>{name}</b>」远程{canControl ? "控制" : "查看"}
          </span>
          <span className={styles.pillDanger}>{capabilityLabel(session.capability)}</span>
          {trusted && (
            <span
              className={styles.trustOn}
              title="这台设备发起远程会直接连入；可在设备菜单里恢复逐次询问"
            >
              已免确认
            </span>
          )}
        </div>
        <div className={styles.ibTimerRow}>
          <span className={styles.timer} aria-hidden="true">
            已持续 {formatDuration(now - session.started_ms)}
          </span>
        </div>

        <div className={styles.ibLead}>
          {canControl
            ? "对方可以操作你的键鼠与剪贴板。"
            : "对方只能看画面，不能操作你的键鼠。"}
          主窗口的常驻横幅一直显示着这条会话，随时可结束。
        </div>

        {scopeNotice && (
          <div className={styles.scopeNotice} role="status" aria-live="polite">
            对方把画面范围改成了「{scopeLabelLong(scopeNotice)}」
            <button
              type="button"
              className={styles.scopeNoticeX}
              onClick={onDismissScopeNotice}
            >
              知道了
            </button>
          </div>
        )}

        {/* G6：文件请求确认条。放在「核对用的事实」之前——它是**现在就要做的决定**，
            而下面是「我交出去了什么」的回顾。 */}
        {/* B6：渲染**全部**待响应请求——只摆 asks[0] 时，并发第二个文件请求静默不可见 */}
        {file.asks.map((a) => (
          <RcFileAskCard key={a.id} ask={a} busy={busy} onRespond={file.respond} />
        ))}

        {/* 核对用的事实，不是装饰：指纹是身份锚点，范围和画质是「我交出去了什么」。 */}
        <dl className={styles.ibFacts}>
          <div className={styles.ibFact}>
            <dt>对方指纹</dt>
            <dd>{fingerprintOf(session.peer)}</dd>
          </div>
          <div className={styles.ibFact}>
            <dt>画面范围</dt>
            <dd>{scopeLabelLong(captureScope)}</dd>
          </div>
          <div className={styles.ibFact}>
            <dt>本机画质</dt>
            <dd>{qualityHudLabel(quality, activeQuality)}</dd>
          </div>
          <div className={styles.ibFact}>
            <dt>免确认</dt>
            <dd>{trusted ? "已开启（对方下次直接连入）" : "未开启（每次都问你）"}</dd>
          </div>
        </dl>

        <div className={styles.ibActions}>
          {/* 只在「正被控、最有判断力」的时刻给长期放行入口，文案必须说清它**不是**
              无人值守：会话横幅照常、随时可结束、deny 优先级更高。 */}
          {!trusted && onTrust && (
            <button
              type="button"
              className={styles.miniBtn}
              disabled={busy}
              title="这台设备以后发起远程时直接连入，不再弹确认；可随时在设备菜单里关回。仍可随时结束会话。"
              onClick={onTrust}
            >
              以后不再询问
            </button>
          )}
          <span className={styles.sp} />
          <button
            type="button"
            className={styles.dangerBtn}
            disabled={busy}
            onClick={() => void endWithConfirm()}
          >
            立即结束
          </button>
        </div>
      </div>
    </div>
  );
}
