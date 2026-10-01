/**
 * RcControlBanner — 被控中常驻提示：**胶囊条 + 展开抽屉**（方案 B，2026-09-24）。
 *
 * 前身是三段式横幅（09-22 方案 A）+ 工作台中央大卡片（RcInboundView，已删）：
 * 名字/可控/时长/结束在三层 UI 里各出现 2~3 遍。业界共识（AnyDesk 边框 / RustDesk
 * 细条 / ToDesk 窄条）：被控提示常驻但极轻，详情收进点击展开。本组件照此重构——
 *
 * - **胶囊（默认态，唯一常驻 UI）**：红点 + 名字 + 可控/只看 + 时长 + 橙点徽标
 *   + 结束图标 + 展开箭头。压缩量仍只由 `.who` 承担（09-22 窄窗崩坏的教训）。
 * - **抽屉（点击展开）**：提示条 / 文件请求完整卡片 / 输入权交接（乙-③）/
 *   事实表（指纹·范围·画质·免确认）/ 不发送声音 / 免确认二段确认（U9）+ 立即结束。
 * - **自动展开**：只有**需要用户拍板**的文件请求到达时弹开抽屉一次（规则 15：
 *   对端在等答复，要兜住「人不在旁边」）；编码/画质/范围/扬声器这类纯知会型
 *   通知默认不弹（2026-10-01 用户拍板）——它们没有要按的键，弹出整只抽屉只会
 *   把人从手头的远程操作里拽开，改由胶囊橙点徽标常驻告知，提示条留在抽屉里
 *   待点开查看。徽标留到用户处理完为止。
 */
import { rcCanControl } from "@/lib/rcCapability";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { formatDuration } from "@/lib/rcSessionStats";
import { rcPauseBadgeOf } from "@/lib/rcVideoPause";
import { useRcFile } from "@/hooks/useRcFile";
import { confirmDialog } from "@/lib/confirm";
import type { RcInputPills, RcSession } from "@/lib/api/rc";
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
  inputHold,
  onToggleInputHold,
  lockGranted,
  lockActive,
  onToggleLockGrant,
  inputPills,
  videoPaused,
  onToggleVideoPause,
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
  /** 乙-③：本机键鼠已收回（对端注入正被拦下）。为真时胶囊上挂常驻徽标。 */
  inputHold?: boolean;
  onToggleInputHold?: () => void;
  /** 乙-③：本次会话是否允许对方锁定本机物理输入。 */
  lockGranted?: boolean;
  lockActive?: boolean;
  onToggleLockGrant?: () => void;
  /** 乙-③：抽屉上的「谁在动」两枚结论。 */
  inputPills?: RcInputPills;
  /** 丙-③：本机已暂停向对方推送画面（为真时胶囊行挂常驻徽标）。 */
  videoPaused?: boolean;
  /** 丙-③：暂停 / 恢复对方观看。 */
  onToggleVideoPause?: () => void;
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

  const hasNotes = Boolean(
    scopeNotice || streamNotice || file.asks.length > 0 || spkMutedByPeer || inputHold
  );

  // 丙-③：暂停徽标的文案判据收在 `@/lib/rcVideoPause`（与抽屉里那颗键同一措辞源）。
  const pauseBadge = rcPauseBadgeOf(videoPaused ?? false);

  // 自动展开的边界：**只有文件请求会弹**（见组件头注释，2026-10-01 拍板）。
  const prevAsks = useRef(0);
  useEffect(() => {
    if (file.asks.length > prevAsks.current) setOpen(true);
    prevAsks.current = file.asks.length;
  }, [file.asks.length]);

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

  const canControl = rcCanControl(session.capability);
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
          {hasNotes && (
            <span className={styles.ctrlBadge} title="有需要你处理的提示，点开胶囊查看" />
          )}
        </button>
        {/* 🔴 乙-③：收回状态的常驻徽标挂在 `.ctrlPill` 那一行、**与胶囊主键同级**
            （DOM 里 button 不能套 button，套了既非法又会让点徽标顺带展开抽屉）。
            规则 15.1：触发在抽屉里、状态却常驻成立，那状态就得有个不靠抽屉的落点；
            点它直接归还，不用再把抽屉开一遍。 */}
        {inputHold && onToggleInputHold && (
          <button
            type="button"
            className={styles.pillHold}
            disabled={busy}
            title="你已收回本机键鼠，对方发来的键鼠正被拦下（画面与剪贴板不受影响）。点此归还。"
            onClick={onToggleInputHold}
          >
            键鼠已收回·点此归还
          </button>
        )}
        {/* 丙-③：暂停状态的常驻落点（规则 15.1，与上面那枚同级）。画面暂停是
            「我此刻正在挡对方的眼睛」，抽屉一收起就没人知道自己屏幕上正在发生什么——
            徽标点一下直接恢复，不用把抽屉再开一遍。措辞不许写成「已断开」。 */}
        {pauseBadge && onToggleVideoPause && (
          <button
            type="button"
            className={styles.pillPause}
            disabled={busy}
            title="你已暂停对方看到的画面：会话没断，他还在用你的键鼠和剪贴板，只是看不到新画面。点此恢复推送。"
            onClick={onToggleVideoPause}
          >
            {pauseBadge}
          </button>
        )}
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
            inputHold={inputHold}
            onToggleInputHold={onToggleInputHold}
            lockGranted={lockGranted}
            lockActive={lockActive}
            onToggleLockGrant={onToggleLockGrant}
            inputPills={inputPills}
            videoPaused={videoPaused}
            onToggleVideoPause={onToggleVideoPause}
          />
        </div>
      )}
    </div>
  );
}
