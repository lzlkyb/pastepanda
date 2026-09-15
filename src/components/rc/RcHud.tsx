/**
 * RcHud — 会话画面左下角状态条（诚实文案）。
 */
import styles from "./RemoteComputer.module.css";
import { qualityLabel, scopeLabel } from "@/lib/rcSessionStats";

export function RcHud({
  codec,
  fps,
  rttMs,
  quality,
  scope,
  heartbeatOk,
  pointerLocked,
}: {
  codec: string;
  fps: number;
  rttMs: number;
  quality: string;
  scope: string;
  heartbeatOk: boolean;
  pointerLocked?: boolean;
}) {
  const rttCls = rttMs <= 0 ? "" : rttMs > 200 ? styles.hudWarn : styles.hudOk;
  return (
    <div className={styles.hud}>
      <span className={styles.hudOk}>
        {codec === "h264" ? "H.264" : "JPEG"}
        {fps > 0 ? ` · ${fps}fps` : ""}
      </span>
      {rttMs > 0 && <span className={rttCls}>延迟 ~{rttMs}ms</span>}
      <span>
        {qualityLabel(quality)} · {scopeLabel(scope)}
      </span>
      <span className={heartbeatOk ? styles.hudOk : styles.hudWarn}>
        {heartbeatOk ? "心跳正常" : "心跳超时"}
      </span>
      {pointerLocked && <span className={styles.hudAccent}>指针已锁定</span>}
    </div>
  );
}
