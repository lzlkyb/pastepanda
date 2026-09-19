/**
 * RcViewTools — 画面右上角：适应 / 1:1 / 填充 / 锁定指针 / 全屏。
 *
 * 浮现式（2026-09-19 误触排查引入）：Chrome RDP 连接条 / Moonlight 同款——
 * 常驻悬浮的控制条会永久占据画面一角、吃掉那一带的远程点击；改为
 * 「靠近画面上缘或悬停工具条时滑入，离开 2.5s 后淡出」。隐藏态
 * pointer-events:none，画面右上完全让给远程。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FitMode } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

const FITS: Array<[FitMode, string]> = [
  ["fit", "适应"],
  ["actual", "1:1"],
  ["fill", "填充"],
];
/** 鼠标距画面上缘这么近时唤出工具条。 */
const REVEAL_BAND_PX = 56;
/** 无交互这么久后淡出。 */
const AUTO_HIDE_MS = 2500;

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
  const rootRef = useRef<HTMLDivElement>(null);
  // 初始展示一次（可发现性），2.5s 后淡出；此后靠上缘/悬停唤出
  const [shown, setShown] = useState(true);
  const hideTimer = useRef<number | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShown(false), AUTO_HIDE_MS);
  }, []);

  useEffect(() => {
    scheduleHide();
    const onMove = (e: MouseEvent) => {
      const root = rootRef.current;
      // 工具条的直接父级就是 fakeScreen（画面区）
      const stage = root?.parentElement;
      if (!root || !stage) return;
      const s = stage.getBoundingClientRect();
      const inStage =
        e.clientX >= s.left && e.clientX <= s.right && e.clientY >= s.top && e.clientY <= s.bottom;
      if (!inStage) return;
      const r = root.getBoundingClientRect();
      const overBar =
        e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
      const nearTop = e.clientY - s.top <= REVEAL_BAND_PX;
      if (overBar) {
        // 悬停在工具条上：保持可见，不计时（正在去点按钮）
        setShown(true);
        if (hideTimer.current != null) {
          window.clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
      } else if (nearTop) {
        setShown(true);
        scheduleHide();
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    };
  }, [scheduleHide]);

  return (
    <div
      ref={rootRef}
      className={`${styles.viewTools} ${shown ? "" : styles.viewToolsHidden}`}
      aria-hidden={!shown}
      onMouseLeave={scheduleHide}
    >
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
