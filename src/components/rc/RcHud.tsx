/**
 * RcHud — 会话画面左下角状态条（诚实文案）。
 *
 * 每一格只说自己那一件事，互不代言（2026-09-17 改造）：
 * - `linkState` = 链路还活着吗（对端 pong 的新鲜度）
 * - `pathKind`  = 数据走的哪条路（局域网直连 / 公网直连 / 绕中继）
 * - 延迟分档    = 网速感受（<30ms 很流畅 … >200ms 偏慢）
 * - `unansweredSec` = 我操作了但画面没动的秒数
 *
 * 🔴 原来那一格「心跳正常 / 心跳超时」是拿 ping 的本地 invoke 结果 + 画面停滞
 *    一起算的，两个方向都会错。现在只认 pong 新鲜度。
 */
import styles from "./RemoteComputer.module.css";
import {
  linkStateLabel,
  pathKindHint,
  pathKindLabel,
  qualityLabel,
  rttGrade,
  rttGradeLabel,
  scopeLabel,
  type RcLinkState,
} from "@/lib/rcSessionStats";

export function RcHud({
  codec,
  fps,
  rttMs,
  quality,
  scope,
  linkState,
  pathKind,
  unansweredSec,
  pointerLocked,
}: {
  codec: string;
  fps: number;
  rttMs: number;
  quality: string;
  scope: string;
  linkState: RcLinkState;
  /** `lan` / `direct` / `relay`；空串 = 未测到，不显示这一格。 */
  pathKind: string;
  /** 操作后未响应秒数；0 = 不显示。 */
  unansweredSec: number;
  pointerLocked?: boolean;
}) {
  const grade = rttGrade(rttMs);
  const rttCls = grade === "unknown" ? "" : grade === "poor" ? styles.hudWarn : styles.hudOk;
  const linkCls =
    linkState === "connected"
      ? styles.hudOk
      : linkState === "failed"
        ? styles.hudBad
        : styles.hudWarn;
  const path = pathKindLabel(pathKind);
  return (
    <div className={styles.hud}>
      <span className={styles.hudOk}>
        {codec === "h264" ? "H.264" : "JPEG"}
        {fps > 0 ? ` · ${fps}fps` : ""}
      </span>
      {rttMs > 0 && (
        <span className={rttCls}>
          延迟 ~{rttMs}ms{grade !== "unknown" ? ` · ${rttGradeLabel(grade)}` : ""}
        </span>
      )}
      {path && <span title={pathKindHint(pathKind)}>{path}</span>}
      <span>
        {qualityLabel(quality)} · {scopeLabel(scope)}
      </span>
      <span className={linkCls}>{linkStateLabel(linkState)}</span>
      {unansweredSec > 0 && (
        <span className={styles.hudWarn}>操作后 {unansweredSec}s 无画面</span>
      )}
      {pointerLocked && <span className={styles.hudAccent}>指针已锁定</span>}
    </div>
  );
}
