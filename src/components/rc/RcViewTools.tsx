/**
 * RcViewTools — 画面右上角：适应 / 1:1 / 填充 / 锁定指针 / 全屏。
 *
 * 浮现式（2026-09-19 误触排查引入）：Chrome RDP 连接条 / Moonlight 同款——
 * 常驻悬浮的控制条会永久占据画面一角、吃掉那一带的远程点击；改为
 * 「靠近画面上缘或悬停工具条时滑入，离开 2.5s 后淡出」。隐藏态
 * pointer-events:none + visibility:hidden（移出 Tab 环，P2-12）。
 *
 * P2-12 / 规则 8：mousemove 只挂在**画面容器**（stage）上，不再用 window——
 * 全局 mousemove 在工具条无关区域也常开，4 窗口还要各自乘一份。
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
    // 监听挂在父级画面容器上（fakeScreen），不挂在 window
    const root = rootRef.current;
    const stage = root?.parentElement;
    if (!stage) return;
    const onMove = (e: MouseEvent) => {
      const r = root?.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      if (!root || !r) return;
      const inStage =
        e.clientX >= s.left && e.clientX <= s.right && e.clientY >= s.top && e.clientY <= s.bottom;
      if (!inStage) return;
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
    stage.addEventListener("mousemove", onMove);
    return () => {
      stage.removeEventListener("mousemove", onMove);
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    };
  }, [scheduleHide]);

  // P2-12：隐藏时按钮 tabIndex={-1} + visibility:hidden，双重确保进不了 Tab 环
  const hidden = !shown;

  return (
    <div
      ref={rootRef}
      className={`${styles.viewTools} ${hidden ? styles.viewToolsHidden : ""}`}
      aria-hidden={hidden}
      onMouseLeave={scheduleHide}
    >
      {FITS.map(([k, label]) => (
        <button
          key={k}
          type="button"
          tabIndex={hidden ? -1 : undefined}
          className={fit === k ? styles.toolOn : undefined}
          onClick={() => onFit(k)}
        >
          {label}
        </button>
      ))}
      {canControl && (
        <button
          type="button"
          tabIndex={hidden ? -1 : undefined}
          className={pointerLocked ? styles.toolOn : undefined}
          title="捕获系统指针，拖出画面边缘不丢事件"
          onClick={onTogglePointer}
        >
          {pointerLocked ? "解锁指针" : "锁定指针"}
        </button>
      )}
      <button
        type="button"
        tabIndex={hidden ? -1 : undefined}
        className={fullscreen ? styles.toolOn : undefined}
        title="全屏显示远程画面"
        onClick={onToggleFullscreen}
      >
        {fullscreen ? "退出全屏" : "全屏"}
      </button>
    </div>
  );
}
