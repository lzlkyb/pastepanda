/**
 * RcStatusBar — 会话底部状态条：键盘捕获 / 指针 / 1:1 / 停滞。
 */
import type { FitMode } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

export function RcStatusBar({
  kbOn,
  pointerLocked,
  fit,
  sizeW,
  stalled,
}: {
  kbOn: boolean;
  pointerLocked: boolean;
  fit: FitMode;
  sizeW: number;
  stalled: boolean;
}) {
  return (
    <div className={styles.statusBar}>
      <span>
        {kbOn ? "键盘已捕获 · Esc 先释放，再按确认结束" : "点画面捕获键盘 · 系统键无法注入"}
      </span>
      {pointerLocked && <span> · 指针已锁定 · Esc 或按钮解除</span>}
      {fit === "actual" && sizeW > 0 && <span> · 1:1 可拖动滚动条平移</span>}
      {stalled && <span className={styles.fbBad}> · 画面超过 2.5s 未更新</span>}
    </div>
  );
}
