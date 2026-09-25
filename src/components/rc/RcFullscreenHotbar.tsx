/**
 * RcFullscreenHotbar — 全屏会话态的顶边 hot zone 控制条（方案 B，2026-09-24）。
 *
 * Fullscreen API 全屏的是 fakeScreen 子树（useRcDisplayMode 对 screenRef 调
 * requestFullscreen），顶条 / 系统控件全都不在画面里——全屏态想退出、结束会话、
 * 控制窗口，只能靠本条。类 Parsec / VLC 的浮现式：
 *
 * - 唤出：鼠标进入 fakeScreen **顶边 8px 热区**（REVEAL_BAND_PX）或悬停本条。
 *   🔴 指针锁定（Pointer Lock）时**不唤出**——锁住的指针没有真实光标，
 *      mousemove 的 clientY 停在锁定前位置，靠它唤出是假象；Esc 解锁后再呼出。
 * - 隐藏：无交互 2.5s 淡出（与 RcViewTools 同参数）；隐藏态 pointer-events:none
 *   + visibility:hidden + tabIndex=-1（P2-12 三重，不占画面点击、不进 Tab 环）。
 * - 布局：左段显示组（适应/1:1/填充/指针锁/退出全屏）+ 结束会话 + 画面信息；
 *   **窗口三键在最右**（Windows 习惯位，关闭键贴屏幕右上角）——用户指定。
 *
 * 挂载位置必须在 fakeScreen 内部（RcSessionStage），否则全屏下不可见。
 * 样式在 RemoteComputer.module.css `.fsBar*`；浮现状态机与 RcViewTools 同构。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logger } from "@/lib/logger";
import type { FitMode } from "@/lib/rcSessionStats";
import { WindowControlIcon, useMaximized } from "./RcWindowControls";
import styles from "./RemoteComputer.module.css";

const FITS: Array<[FitMode, string]> = [
  ["fit", "适应"],
  ["actual", "1:1"],
  ["fill", "填充"],
];
/** 鼠标距画面顶缘这么近时唤出（热区比 viewTools 的 56px 窄——只贴边，少吃远程点击）。 */
const REVEAL_BAND_PX = 8;
/** 无交互这么久后淡出。 */
const AUTO_HIDE_MS = 2500;

/** 同 RcWindowControls.runWin：非 Tauri 环境（浏览器看版式 / vitest）同步抛，得兜。 */
function runWin(fn: () => Promise<unknown>, what: string) {
  try {
    void fn().catch((e) => logger.warn(`窗口${what}失败`, e));
  } catch (e) {
    logger.warn(`窗口${what}失败`, e);
  }
}

export function RcFullscreenHotbar({
  fit,
  onFit,
  pointerLocked,
  onTogglePointer,
  canControl,
  onToggleFullscreen,
  onRequestEnd,
  busy,
  info,
}: {
  fit: FitMode;
  onFit: (m: FitMode) => void;
  pointerLocked: boolean;
  onTogglePointer: () => void;
  canControl: boolean;
  onToggleFullscreen: () => void;
  /** 与 RcSessionTop 同一个回调（父级包了 ConfirmDialog，这里只触发）。 */
  onRequestEnd: () => void;
  busy: boolean;
  /** 画面信息串（如 `2560×1440 · H.264 · 60fps`）；空串则不占位。 */
  info: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 初始展示一次（可发现性），2.5s 后淡出；此后靠顶边热区/悬停唤出
  const [shown, setShown] = useState(true);
  const hideTimer = useRef<number | null>(null);
  const maximized = useMaximized();

  const scheduleHide = useCallback(() => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShown(false), AUTO_HIDE_MS);
  }, []);

  useEffect(() => {
    scheduleHide();
    // 监听挂在父级（fakeScreen）上，不挂 window——与 RcViewTools 同理（P2-12）
    const root = rootRef.current;
    const stage = root?.parentElement;
    if (!stage) return;
    const onMove = (e: MouseEvent) => {
      if (pointerLocked) return; // 锁定指针时假光标唤不出（见文件头 🔴）
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
        // 悬停在控制条上：保持可见，不计时（正在去点按钮）
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
  }, [scheduleHide, pointerLocked]);

  const hidden = !shown;

  return (
    <div
      ref={rootRef}
      className={`${styles.fsBar} ${hidden ? styles.viewToolsHidden : ""}`}
      aria-hidden={hidden}
      onMouseLeave={scheduleHide}
      // 🔴 再审计（hotbar 盲开键盘捕获，2026-09-25）：非按钮区 mousedown 原先
      // 冒泡到 fakeScreen 的 onMouseDown → focus → setKbOn(true)，点 hotbar
      // 空白就盲开键盘捕获、输入打进远程机器。这里在根容器截停冒泡——按钮的
      // onClick 是独立事件不受影响。已知限制：hotbar 显示期间没有「键盘已捕获」
      // 指示（属新 UI，另行设计稿流程再补）。
      onMouseDown={(e) => e.stopPropagation()}
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
        title="退出全屏显示远程画面"
        onClick={onToggleFullscreen}
      >
        退出全屏
      </button>
      <span className={styles.fsSep} aria-hidden="true" />
      <button
        type="button"
        tabIndex={hidden ? -1 : undefined}
        className={styles.fsDanger}
        disabled={busy}
        onClick={onRequestEnd}
      >
        结束会话
      </button>
      {info && <span className={styles.fsInfo}>{info}</span>}
      {/* 窗口三键：margin-left:auto 推到最右（Windows 习惯位）。语义与
          RcWindowControls 完全一致（minimize / toggleMaximize / close），
          仅样式是本条的深色窄版——关闭仍走 close()，不绕会话确认。 */}
      <div className={styles.fsWin} data-tauri-drag-region="false">
        <button
          type="button"
          tabIndex={hidden ? -1 : undefined}
          className={styles.fsWinBtn}
          aria-label="最小化"
          title="最小化"
          onClick={() => runWin(() => getCurrentWindow().minimize(), "最小化")}
        >
          <WindowControlIcon name="min" />
        </button>
        <button
          type="button"
          tabIndex={hidden ? -1 : undefined}
          className={styles.fsWinBtn}
          aria-label={maximized ? "向下还原" : "最大化"}
          title={maximized ? "向下还原" : "最大化"}
          onClick={() =>
            runWin(() => getCurrentWindow().toggleMaximize(), maximized ? "还原" : "最大化")
          }
        >
          <WindowControlIcon name={maximized ? "restore" : "max"} />
        </button>
        <button
          type="button"
          tabIndex={hidden ? -1 : undefined}
          className={`${styles.fsWinBtn} ${styles.fsWinBtnClose}`}
          aria-label="关闭"
          title="关闭"
          onClick={() => runWin(() => getCurrentWindow().close(), "关闭")}
        >
          <WindowControlIcon name="close" />
        </button>
      </div>
    </div>
  );
}
