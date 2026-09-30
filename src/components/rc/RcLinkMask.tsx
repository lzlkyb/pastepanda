/**
 * RcLinkMask — 链路中断时盖在**冻结画面**上的遮罩（甲-③，2026-09-29，
 * design/远程电脑-交互审计整改-甲乙丙-设计稿.html §甲-③）。
 *
 * 补的是 C3：断连后画面停在最后一帧，唯一的说明是浮条里那枚会随 2.5s 淡出的琥珀/红
 * pill——浮条一收，用户面对的是一张「静悄悄的还是活的」的图。遮罩挂在 `fakeScreen`
 * 里（= 在全屏元素 `.sessionWrap` 的子树内），所以窗口态与全屏态都看得见。
 *
 * 文案口径（对标 §6.6 + 待拍板⑤）：**只讲结果**，不写「第 N/M 次」——各家都把自动
 * 重连当默认体验而非用户决策点。判据在 `lib/rcLinkMask`，这里只摆两态：
 * - `recovering`：「正在尝试恢复」+ 明说用户不需要做任何事；
 * - `consent`：「需要对方重新同意」+ 按钮改口「重新发起」。
 *
 * ⚠️ 遮罩必须自带出口（结束会话）且能穿透收起：它 `pointer-events:auto` 会吃掉画面上的
 * 点击——那正是意图（链路都断了，不该再往对端注入鼠标），但出口按钮必须在。
 */
import { Loader2 } from "lucide-react";
import { rcLinkMaskPhase } from "@/lib/rcLinkMask";
import styles from "./RemoteComputer.module.css";

export function RcLinkMask({
  hasFrame,
  state,
  busy,
  peerName,
  onReconnect,
  onRequestEnd,
}: {
  hasFrame: boolean;
  state: Parameters<typeof rcLinkMaskPhase>[0]["state"];
  busy: boolean;
  peerName: string;
  /** 重新发起（父级已包 confirmDialog）。 */
  onReconnect?: () => void;
  /** 结束会话（父级已包 confirmDialog）。 */
  onRequestEnd: () => void;
}) {
  const phase = rcLinkMaskPhase({ hasFrame, state, busy });
  if (!phase) return null;
  const recovering = phase === "recovering";
  return (
    <div className={styles.linkMask} role="alert">
      <div className={styles.linkMaskCard}>
        <span className={styles.linkMaskChip}>
          <i
            aria-hidden="true"
            className={`${styles.linkMaskDot} ${recovering ? styles.linkMaskDotRun : ""}`}
          />
          {recovering ? "连接中断，正在尝试恢复" : "连接已中断"}
        </span>
        <b className={styles.linkMaskTitle}>{recovering ? "正在尝试恢复" : "需要对方重新同意"}</b>
        <p className={styles.linkMaskText}>
          {recovering
            ? `与「${peerName}」的链路断了。恢复后会自动回到画面，你不需要做任何事。`
            : `与「${peerName}」的连接已经结束。重新发起会再敲一次对方的门，需要对方同意。`}
        </p>
        <div className={styles.linkMaskRow}>
          <button type="button" className={styles.linkMaskBtn} onClick={onRequestEnd}>
            结束会话
          </button>
          {onReconnect && (
            <button
              type="button"
              className={`${styles.linkMaskBtn} ${styles.linkMaskBtnPri}`}
              disabled={busy}
              onClick={onReconnect}
            >
              {busy && <Loader2 size={12} className={styles.spin} aria-hidden="true" />}
              {recovering ? "立即重连" : "重新发起"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
