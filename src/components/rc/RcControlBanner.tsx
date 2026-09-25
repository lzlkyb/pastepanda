/**
 * RcControlBanner — 被控中常驻提示：**胶囊条 + 展开抽屉**（方案 B，2026-09-24）。
 *
 * 前身是三段式横幅（09-22 方案 A）+ 工作台中央大卡片（RcInboundView，已删）：
 * 名字/可控/时长/结束在三层 UI 里各出现 2~3 遍。业界共识（AnyDesk 边框 / RustDesk
 * 细条 / ToDesk 窄条）：被控提示常驻但极轻，详情收进点击展开。本组件照此重构——
 *
 * - **胶囊（默认态，唯一常驻 UI）**：红点 + 名字 + 可控/只看 + 时长 + 橙点徽标
 *   + 结束图标 + 展开箭头。压缩量仍只由 `.who` 承担（09-22 窄窗崩坏的教训）。
 * - **抽屉（点击展开）**：提示条 / 文件请求完整卡片 / 事实表（指纹·范围·画质·
 *   免确认）/ 不发送声音 / 免确认二段确认（U9）+ 立即结束。
 * - **自动展开**：文件请求或对端变更到达时弹开抽屉一次（规则 15：触发可见），
 *   胶囊同时挂橙点徽标；用户收起后不重复弹，徽标留到处理完。
 */
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { formatDuration } from "@/lib/rcSessionStats";
import { useRcFile } from "@/hooks/useRcFile";
import { confirmDialog } from "@/lib/confirm";
import type { RcSession } from "@/lib/api/rc";
import { RcControlDrawer } from "./RcControlDrawer";
import styles from "./RemoteComputer.module.css";

export function RcControlBanner({
  session,
  busy,
  trusted,
  onTrust,
  onEnd,
  scopeNotice,
  onDismissScopeNotice,
  streamNotice,
  onDismissStreamNotice,
  audioLocalMute,
  onToggleAudioLocalMute,
  spkMutedByPeer,
  onRestoreSpk,
  quality,
  activeQuality,
  captureScope,
}: {
  session: RcSession;
  busy: boolean;
  /** 方案 D：该对端是否已开免确认（发起时跳过本机确认条）。 */
  trusted?: boolean;
  /** A2：就地开启免确认——「以后不再询问这台设备」。不传 = 不显示。 */
  onTrust?: () => void;
  onEnd: () => void;
  /** 对端刚改成的画面范围；null 表示没有待展示的变更 */
  scopeNotice?: string | null;
  onDismissScopeNotice?: () => void;
  /** Q10：对端刚改的推流档位（quality / codec）；null 表示没有待展示的变更 */
  streamNotice?: { kind: string; name: string } | null;
  onDismissStreamNotice?: () => void;
  /** G3：本机是否已静音系统声音（一票否决——对端开着也听不到）。 */
  audioLocalMute?: boolean;
  /** G3：切换本机静音。不传 = 不显示（非 Windows 被控端无音频链路）。 */
  onToggleAudioLocalMute?: () => void;
  /** G3-C：对端静音了本机扬声器（物理外放被远程关掉）。不传/否 = 不摆提示。 */
  spkMutedByPeer?: boolean;
  /** G3-C：本机一键恢复外放。不传 = 只提示不给入口（不摆半条路）。 */
  onRestoreSpk?: () => void;
  /** 本机被控编码档（auto / uhd / …），事实表用。 */
  quality?: string;
  /** auto 时**实际生效**的档。 */
  activeQuality?: string;
  /** 本机采集范围，事实表用。 */
  captureScope?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [session.id]);

  // G6：文件请求可能**在没有会话时**到达（文件通道独立于会话），那种情况走
  // RcOverlay 的常驻分支。有会话时进抽屉——自动展开兜住「人不在旁边」的情况（规则 15）。
  const file = useRcFile(session.peer);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const drawerId = useId();

  const hasNotes = Boolean(scopeNotice || streamNotice || file.asks.length > 0 || spkMutedByPeer);

  // 自动展开：只在「新东西到达」时弹一次。asks 按数量增量判（并发第二个请求不重复弹）；
  // notice 按内容签名判——用户点「知道了」清掉后再来新的会再次展开。
  const prevAsks = useRef(0);
  useEffect(() => {
    if (file.asks.length > prevAsks.current) setOpen(true);
    prevAsks.current = file.asks.length;
  }, [file.asks.length]);
  const prevNoticeSig = useRef("");
  useEffect(() => {
    const sig = `${scopeNotice ?? ""}|${streamNotice ? `${streamNotice.kind}:${streamNotice.name}` : ""}|${spkMutedByPeer ? 1 : 0}`;
    if (sig !== prevNoticeSig.current) {
      if (scopeNotice || streamNotice || spkMutedByPeer) setOpen(true);
      prevNoticeSig.current = sig;
    }
  }, [scopeNotice, streamNotice, spkMutedByPeer]);

  // 展开时：Esc / 点击胶囊外收起。抽屉是就地展开不是模态，用户去点别处 = 收起意图。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const canControl = session.capability === "control";
  const name = rcDisplayName(session, fingerprintOf(session.peer));

  // U1：结束要确认——按钮挨着高频操作（胶囊上、抽屉里都是），误触代价不对称。
  const endWithConfirm = () => {
    void (async () => {
      const ok = await confirmDialog({
        title: "结束远程会话",
        message: `将断开与「${name}」的连接。对方会立刻失去画面与控制。`,
        confirmText: "结束会话",
        variant: "danger",
      });
      if (ok) onEnd();
    })();
  };

  return (
    <div className={styles.ctrlPillWrap} ref={rootRef}>
      <div className={styles.ctrlPill}>
        <button
          type="button"
          className={styles.ctrlPillMain}
          aria-expanded={open}
          aria-controls={drawerId}
          title={open ? "收起会话详情" : "展开会话详情（指纹 / 画质 / 免确认 / 结束）"}
          onClick={() => setOpen(!open)}
        >
          <span className={styles.dotDanger} aria-hidden="true" />
          {/* C5：live region 只包「状态变化」（名字 + 可控/只看），不包每秒刷新的计时器。
              窄窗压缩模型沿用 09-22 结论：压缩量全部交给 .who 一个元素。 */}
          <span className={styles.whoLive} role="status" aria-live="polite">
            <span className={styles.who}>正在被「{name}」远程</span>
            <span className={styles.pillDanger}>{canControl ? "可控" : "只看"}</span>
          </span>
          {/* 计时器：纯视觉、每秒变，移出 live region，避免屏幕阅读器每秒播报 */}
          <span className={styles.timer} aria-hidden="true">
            {formatDuration(now - session.started_ms)}
          </span>
          {hasNotes && <span className={styles.ctrlBadge} title="有需要你处理的提示（已自动展开过抽屉）" />}
        </button>
        <button
          type="button"
          className={styles.ctrlPillEnd}
          disabled={busy}
          aria-label="立即结束"
          title="立即结束（需确认）"
          onClick={endWithConfirm}
        >
          <X size={13} aria-hidden="true" />
        </button>
        <span className={styles.ctrlPillChev} aria-hidden="true">
          <ChevronDown size={13} className={open ? styles.chevUp : undefined} />
        </span>
      </div>

      {open && (
        <div className={styles.ctrlDrawer} id={drawerId}>
          <RcControlDrawer
            session={session}
            busy={busy}
            trusted={trusted}
            onTrust={onTrust}
            onEnd={endWithConfirm}
            scopeNotice={scopeNotice}
            onDismissScopeNotice={onDismissScopeNotice}
            streamNotice={streamNotice}
            onDismissStreamNotice={onDismissStreamNotice}
            audioLocalMute={audioLocalMute}
            onToggleAudioLocalMute={onToggleAudioLocalMute}
            spkMutedByPeer={spkMutedByPeer}
            onRestoreSpk={onRestoreSpk}
            quality={quality}
            activeQuality={activeQuality}
            captureScope={captureScope}
          />
        </div>
      )}
    </div>
  );
}
