/**
 * 折叠态（pill / peek / clear）岛体左侧那枚指示器：提醒铃 / 全清勾 / 进度环 + 剩余数。
 *
 * 从 `TodoIsland` 拆出（规则 #7：单文件 300 行红线）。三者互斥，由父级的
 * `reminding` 与 `stage` 决定显示哪一枚；一次性动画（shake / draw）的开关状态
 * 在 `useIslandVitality`，这里只负责挂 `data-*` 并在 `animationEnd` 交回去。
 *
 * 全清勾与列表行 `TickSvg` 是同一条路径（设计稿修正 #2：同一语义不许两套实现）。
 */
import styles from "./TodoIsland.module.css";

/** 进度环周长 = 2πr（r = 6.5，与 CSS 里 `circle r="6.5"` 是同一份账） */
const RING_CIRC = 2 * Math.PI * 6.5;

interface Props {
  /** true = 提醒接管（整段换成铃 + 「到点了」） */
  reminding: boolean;
  /** stage === "clear" 时把环换成描画的勾 */
  cleared: boolean;
  remain: number;
  progress: number;
  shaking: boolean;
  drawing: boolean;
  onShakeEnd: () => void;
  onDrawEnd: () => void;
}

export function IslandCollapsedMark({
  reminding,
  cleared,
  remain,
  progress,
  shaking,
  drawing,
  onShakeEnd,
  onDrawEnd,
}: Props) {
  if (reminding) {
    return (
      <>
        <svg className={styles.bell} data-shake={shaking ? "1" : undefined} onAnimationEnd={onShakeEnd} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2.5z" />
          <path d="M6.8 12.5a1.3 1.3 0 0 0 2.4 0" />
        </svg>
        <span className={styles.remindWord}>到点了</span>
        <span className={styles.sepdot} />
      </>
    );
  }

  if (cleared) {
    return (
      <span className={styles.okmark} data-draw={drawing ? "1" : undefined} onAnimationEnd={onDrawEnd} aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M3 8.5l3.4 3.4L13 5" />
        </svg>
      </span>
    );
  }

  return (
    <>
      {/* 环与数字是纯视觉通道；读屏用户拿到的口径在父级的 aria-label（还剩 N 项） */}
      <svg className={styles.ring} viewBox="0 0 16 16" aria-hidden="true">
        <circle className={styles.tk2} cx="8" cy="8" r="6.5" />
        <circle
          className={styles.arc}
          cx="8"
          cy="8"
          r="6.5"
          strokeDasharray={RING_CIRC}
          strokeDashoffset={RING_CIRC * (1 - progress)}
        />
      </svg>
      <span className={styles.cnt}>{remain}</span>
      <span className={styles.sepdot} />
    </>
  );
}
