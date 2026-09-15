/**
 * RcViewTools — 画面右上角：适应 / 1:1 / 填充 / 锁定指针 / 全屏。
 */
import type { FitMode } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

const FITS: Array<[FitMode, string]> = [
  ["fit", "适应"],
  ["actual", "1:1"],
  ["fill", "填充"],
];

export function RcViewTools({
  fit,
  onFit,
  pointerLocked,
  onTogglePointer,
  canControl,
  fullscreen,
  onToggleFullscreen,
}: {
  fit: FitMode;
  onFit: (m: FitMode) => void;
  pointerLocked: boolean;
  onTogglePointer: () => void;
  canControl: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <div className={styles.viewTools}>
      {FITS.map(([k, label]) => (
        <button
          key={k}
          type="button"
          className={fit === k ? styles.toolOn : undefined}
          onClick={() => onFit(k)}
        >
          {label}
        </button>
      ))}
      {canControl && (
        <button
          type="button"
          className={pointerLocked ? styles.toolOn : undefined}
          title="捕获系统指针，拖出画面边缘不丢事件"
          onClick={onTogglePointer}
        >
          {pointerLocked ? "解锁指针" : "锁定指针"}
        </button>
      )}
      <button
        type="button"
        className={fullscreen ? styles.toolOn : undefined}
        title="全屏显示远程画面"
        onClick={onToggleFullscreen}
      >
        {fullscreen ? "退出全屏" : "全屏"}
      </button>
    </div>
  );
}
