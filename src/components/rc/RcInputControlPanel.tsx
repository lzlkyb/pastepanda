/**
 * RcInputControlPanel — 被控抽屉里的**本机控制权**一节（乙-③ + 丙-③，2026-09-30）。
 *
 * 单独成文件是因为 `RcControlDrawer.tsx` 已接近 300 行红线（规则 7，丙-③ 加完是 294 行），
 * 这三行 UI 会把它推过去。
 *
 * 三个键动的是**不同的人的手与眼**，并排摆在一起、措辞各自说清（文案唯一真源是
 * `@/lib/rcInputGate` 与 `@/lib/rcVideoPause`）：
 * - 「暂时收回我的键鼠」＝我自己的键鼠先归我用，**对方发来的**键鼠被拦下；
 * - 「允许对方锁定我的输入」＝给他一把能吞掉**我本人物理键鼠**的钥匙（默认关，本次会话）；
 * - 「暂停对方观看」＝不再推送画面，他看到停在当前这一帧（丙-③：会话不断，键鼠照用）。
 *
 * 下面那两枚「谁在动」的 pill 是这张面板的存在理由：收回之后画面照常在动，
 * 若没有「对方无权却被按下（已拦）」这枚红的，被控者会以为对方闲置着。
 *
 * 🔴 状态一律以后端投影为准，不做纯乐观置位：收回会在十分钟无本机操作后
 *   **自动归还**，按钮停在本地值上就成了假状态。
 */
import { Keyboard, MousePointer2 } from "lucide-react";
import { rcGrantButtonOf, rcHoldButtonOf, rcInputPillViews } from "@/lib/rcInputGate";
import { rcPauseButtonOf } from "@/lib/rcVideoPause";
import type { RcInputPills } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

const toneCls = {
  peer: styles.inputPillPeer,
  local: styles.inputPillLocal,
  blocked: styles.inputPillBlocked,
} as const;

const PillIcon: Record<"keyboard" | "mouse", typeof Keyboard> = {
  keyboard: Keyboard,
  mouse: MousePointer2,
} as const;

export function RcInputControlPanel({
  hold,
  granted,
  lockActive,
  pills,
  busy,
  onToggleHold,
  onToggleGrant,
  videoPaused,
  onToggleVideoPause,
}: {
  /** 本机是否已收回键鼠（对端注入正被拦下）。 */
  hold: boolean;
  /** 本次会话是否允许对方锁定本机物理输入。 */
  granted: boolean;
  /** 对方的锁定现在真的生效（读对方钩子实际闸位）。 */
  lockActive: boolean;
  /** 「谁在动」两枚结论（旧后端缺值 → 整行不摆，不摆「未知」）。 */
  pills?: RcInputPills;
  busy: boolean;
  onToggleHold: () => void;
  /** 不传 = 不摆授权键（与抽屉里「不发送声音」同款纪律：不给半条路）。 */
  onToggleGrant?: () => void;
  /** 丙-③：本机是否已暂停向对方推送画面。 */
  videoPaused?: boolean;
  /** 丙-③：暂停 / 恢复对方观看。不传 = 不摆这一键。 */
  onToggleVideoPause?: () => void;
}) {
  const holdBtn = rcHoldButtonOf(hold);
  const grantBtn = rcGrantButtonOf(granted, lockActive);
  const pauseBtn = rcPauseButtonOf(videoPaused ?? false);
  const views = rcInputPillViews(pills);

  return (
    <div className={styles.inputPanel}>
      <div className={styles.inputPanelActs}>
        <button
          type="button"
          className={hold ? `${styles.inputActBtn} ${styles.inputActBtnOn}` : styles.inputActBtn}
          aria-pressed={hold}
          disabled={busy}
          title={holdBtn.tip}
          onClick={onToggleHold}
        >
          {holdBtn.label}
        </button>
        {/* 丙-③：暂停画面与收回键鼠同为「我此刻收回了一样东西」，绿态同族。
            两键并排正是要害——挡眼睛 / 挡的手是两条正交的路，措辞各自说清。 */}
        {onToggleVideoPause && (
          <button
            type="button"
            className={
              videoPaused ? `${styles.inputActBtn} ${styles.inputActBtnOn}` : styles.inputActBtn
            }
            aria-pressed={videoPaused ?? false}
            disabled={busy}
            title={pauseBtn.tip}
            onClick={onToggleVideoPause}
          >
            {pauseBtn.label}
          </button>
        )}
        {onToggleGrant && (
          <button
            type="button"
            className={
              granted ? `${styles.inputActBtn} ${styles.inputActBtnGrant}` : styles.inputActBtn
            }
            aria-pressed={granted}
            disabled={busy}
            title={grantBtn.tip}
            onClick={onToggleGrant}
          >
            {grantBtn.label}
          </button>
        )}
      </div>
      {(granted || lockActive) && /Mac/i.test(navigator.platform) && (
        <span className={styles.inputLockNow} role="status">
          按 Control+Option+Esc 可立即解除输入锁定，PastePanda 窗口内仍可操作。
        </span>
      )}
      {lockActive && (
        <span className={styles.inputLockNow} role="status" aria-live="polite">
          对方现在锁着你的键盘鼠标（远程操作照常）
        </span>
      )}
      {/* 「谁在动」只在窗口内有点亮的才摆；两枚都 idle 时这行整体消失，
          抽屉不会凭空挂两枚读不懂的灰点。 */}
      {views.length > 0 && (
        <div className={styles.inputPills} role="status" aria-live="polite">
          {views.map((p) => {
            const Icon = PillIcon[p.key];
            return (
              <span key={p.key} className={`${styles.inputPill} ${toneCls[p.tone]}`}>
                <Icon size={11} aria-hidden="true" />
                {p.subject}·{p.phrase}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
