/**
 * RcCapsuleWinKeys — 全屏态挂在胶囊右端的**窗口两键**（最小化 + 关闭）。
 *
 * 为什么在胶囊里而不是顶栏：会话壳全屏时 `.viewTop` 整条退场（RcSessionStage 裁决），
 * 窗口键只能跟着浮条走。最大化在全屏无意义所以不摆；关闭仍走 `rc_window_close`
 * 命令语义（与原全屏 hotbar 同一条，「有会话先问」的关闭守卫不变），不绕会话确认。
 * 方形按钮 + hover 红底与左边的圆角胶囊键分族，避免和「结束会话」那颗 ✕ 混淆。
 *
 * 从 `RcSessionCapsule` 抽出的直接原因是 `.tsx ≤ 300` 红线（甲-② 要在同一层加出口条）。
 */
import { WindowControlIcon } from "./RcWindowControls";
import { rcWindowClose, rcWindowMinimize } from "@/lib/rcWindowOps";
import styles from "./RemoteComputer.module.css";

export function RcCapsuleWinKeys({
  tab,
  onStatus,
}: {
  /** 浮条收起态 = -1：隐形元素不该进 Tab 环。 */
  tab: number | undefined;
  onStatus: (msg: string, kind: "success" | "error" | "info") => void;
}) {
  return (
    <>
      <span className={styles.capSep} aria-hidden="true" />
      <span className={styles.capWin} data-tauri-drag-region="false">
        <button
          type="button"
          tabIndex={tab}
          className={styles.capWinBtn}
          aria-label="最小化"
          title="最小化"
          onClick={() => void rcWindowMinimize(onStatus)}
        >
          <WindowControlIcon name="min" />
        </button>
        <button
          type="button"
          tabIndex={tab}
          className={`${styles.capWinBtn} ${styles.capWinBtnClose}`}
          aria-label="关闭"
          title="关闭窗口"
          onClick={() => void rcWindowClose(onStatus)}
        >
          <WindowControlIcon name="close" />
        </button>
      </span>
    </>
  );
}
