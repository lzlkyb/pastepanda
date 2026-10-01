/**
 * SessionToolbar — 会话工具条，竖屏 = 常驻底栏，横屏 = 顶缘胶囊（沉浸可隐藏）。
 *
 * 同构不换布局（design §5.3）：同一组六键两个朝向，只换容器定位。横屏隐藏态
 * 三重纪律照搬桌面 RcSessionCapsule：pointer-events:none + visibility:hidden +
 * 不进 Tab 环（隐藏的胶囊矩形不构成触摸目标）。
 *
 * 剪贴板是一个入口弹两选（推/取）：工具条竖屏 360px 宽放不下七个带字按钮，
 * 两步操作只用在「选方向」这一下，高频路径仍是单击开菜单。
 * hint 与触发同域渲染（规则 15.1）——工具条在哪它就在哪，胶囊隐藏时同隐。
 */
import styles from "./RcMobileSession.module.css";

export type MobileKeyMode = "type" | "direct";

export function SessionToolbar({
  landscape,
  visible,
  keyboardOn,
  onToggleKeyboard,
  onResetZoom,
  quality,
  onCycleQuality,
  audioOn,
  onToggleAudio,
  onToggleOrientation,
  hint,
  clipOpen,
  onToggleClip,
  onClipPush,
  onClipPull,
  onEnd,
  onInteract,
}: {
  landscape: boolean;
  /** 横屏沉浸显隐；竖屏恒 true（常驻）。 */
  visible: boolean;
  keyboardOn: boolean;
  onToggleKeyboard: () => void;
  onResetZoom: () => void;
  quality: string;
  onCycleQuality: () => void;
  audioOn: boolean;
  onToggleAudio: () => void;
  /** 横屏 ⇄ 竖屏：竖屏态文案「横屏」，横屏态文案「竖屏」（2026-10-01 用户拍板）。 */
  onToggleOrientation: () => void;
  /** 操作反馈一句话（几秒自清）；空串 = 不占位。 */
  hint: string;
  clipOpen: boolean;
  onToggleClip: () => void;
  onClipPush: () => void;
  onClipPull: () => void;
  onEnd: () => void;
  /** 胶囊上任意触摸续期 2.5s（仅横屏有意义）。 */
  onInteract: () => void;
}) {
  const cls = landscape
    ? `${styles.toolbar} ${styles.toolbarCapsule} ${visible ? "" : styles.toolbarHidden}`
    : styles.toolbar;
  return (
    <nav
      className={cls}
      /* 隐藏态不进 Tab 环：visibility:hidden 已让焦点不可达，tabIndex 显式兜底 */
      tabIndex={visible ? 0 : -1}
      onPointerDown={onInteract}
    >
      {hint && (
        <div className={styles.tbHint} role="status">
          {hint}
        </div>
      )}
      <button type="button" className={`${styles.tbBtn} ${keyboardOn ? styles.tbOn : ""}`} onClick={onToggleKeyboard}>
        <span className={styles.tbIcon}>⌨</span>
        <span className={styles.tbLabel}>键盘</span>
      </button>
      <button type="button" className={styles.tbBtn} onClick={onResetZoom}>
        <span className={styles.tbIcon}>🖥</span>
        <span className={styles.tbLabel}>画面</span>
      </button>
      <button type="button" className={styles.tbBtn} onClick={onCycleQuality}>
        <span className={styles.tbIcon}>⚙</span>
        <span className={styles.tbLabel}>{quality}</span>
      </button>
      <div className={styles.tbWrap}>
        <button
          type="button"
          className={`${styles.tbBtn} ${clipOpen ? styles.tbOn : ""}`}
          onClick={onToggleClip}
          aria-expanded={clipOpen}
        >
          <span className={styles.tbIcon}>⧉</span>
          <span className={styles.tbLabel}>剪贴</span>
        </button>
        {clipOpen && (
          <div className={styles.tbMenu} role="menu" aria-label="剪贴板操作">
            <button type="button" role="menuitem" className={styles.tbMenuItem} onClick={onClipPush}>
              推到电脑
            </button>
            <button type="button" role="menuitem" className={styles.tbMenuItem} onClick={onClipPull}>
              取到手机
            </button>
          </div>
        )}
      </div>
      <button type="button" className={`${styles.tbBtn} ${audioOn ? styles.tbOn : ""}`} onClick={onToggleAudio}>
        <span className={styles.tbIcon}>{audioOn ? "🔊" : "🔇"}</span>
        <span className={styles.tbLabel}>声音</span>
      </button>
      <button type="button" className={styles.tbBtn} onClick={onToggleOrientation}>
        <span className={styles.tbIcon}>⛶</span>
        <span className={styles.tbLabel}>{landscape ? "竖屏" : "横屏"}</span>
      </button>
      <button type="button" className={`${styles.tbBtn} ${styles.tbEnd}`} onClick={onEnd}>
        <span className={styles.tbIcon}>⏻</span>
        <span className={styles.tbLabel}>断开</span>
      </button>
    </nav>
  );
}
