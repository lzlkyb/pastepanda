/**
 * RcStatusBar — 会话底部状态条：键盘捕获 / 指针 / 1:1 / 画面静止 / 操作未响应。
 *
 * 「画面静止」是**中性观测**（无着色），不是故障：被控端在画面无变化时
 * 刻意不推帧，静止是正常状态。真正的异常是「我操作了但画面没动」——
 * 那一条才给警示色（2026-09-17 改造）。
 */
import type { FitMode } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

export function RcStatusBar({
  kbOn,
  pointerLocked,
  fit,
  sizeW,
  frameIdleSec,
  unansweredSec,
}: {
  kbOn: boolean;
  pointerLocked: boolean;
  fit: FitMode;
  sizeW: number;
  /** 画面静止秒数；0 = 不显示。 */
  frameIdleSec: number;
  /** 操作后未响应秒数；0 = 不显示。 */
  unansweredSec: number;
}) {
  return (
    <div className={styles.statusBar}>
      <span>
        {kbOn ? "键盘已捕获 · Esc 先释放，再按确认结束" : "点画面捕获键盘 · 系统键无法注入"}
      </span>
      {pointerLocked && <span> · 指针已锁定 · Esc 或按钮解除</span>}
      {fit === "actual" && sizeW > 0 && <span> · 1:1 可拖动滚动条平移</span>}
      {frameIdleSec > 0 && <span> · 画面已静止 {frameIdleSec}s</span>}
      {unansweredSec > 0 && (
        <span className={styles.fbWarn}> · 操作后 {unansweredSec}s 未见画面变化</span>
      )}
    </div>
  );
}
