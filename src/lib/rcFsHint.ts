/**
 * 非全屏「画面偏小」提示条判据（案 A · 设计稿 2026-09-20）。
 * 纯函数，便于单测；测量与 React 状态在组件层。
 */

export interface RcFsHintMetrics {
  /** 已进入系统全屏（fakeScreen:fullscreen） */
  fullscreen: boolean;
  /** 本会话用户点过「知道了」 */
  dismissed: boolean;
  /** 已有远端画面 */
  hasFrame: boolean;
  /** 画面舞台 CSS 高度（.fakeScreen clientHeight）；0 = 尚未量到 */
  stageH: number;
  /** 远端内容逻辑宽（帧尺寸） */
  contentW: number;
  /** 远端内容逻辑高 */
  contentH: number;
  /** 画布 CSS 显示宽；0 = 尚未量到 */
  displayW: number;
  /** 画布 CSS 显示高 */
  displayH: number;
}

/** 低于此高度视为「舞台太矮，该全屏」。 */
export const FS_HINT_STAGE_MIN_H = 360;
/** 显示边相对远端内容低于此比例 → 绝对坐标放大比明显，鼠标会显得更快。 */
export const FS_HINT_SCALE = 0.55;

/**
 * 是否展示非全屏轻提示。
 * - 全屏中 / 已点「知道了」/ 无画面 / 无内容尺寸 → 不展示
 * - 舞台高度不足，或显示边相对远端内容过小 → 展示
 * - 尚未量到 display/stage 时：有画面且非全屏且未 dismiss → **不**抢先展示
 *  （避免首帧闪烁；量到后再由 resize/effect 触发）
 */
export function shouldShowFsHint(m: RcFsHintMetrics): boolean {
  if (m.fullscreen || m.dismissed || !m.hasFrame) return false;
  if (!(m.contentW > 0) || !(m.contentH > 0)) return false;
  if (m.stageH > 0 && m.stageH < FS_HINT_STAGE_MIN_H) return true;
  if (m.displayW > 0 && m.displayW < m.contentW * FS_HINT_SCALE) return true;
  if (m.displayH > 0 && m.displayH < m.contentH * FS_HINT_SCALE) return true;
  return false;
}

/** 提示条文案：可控 / 只看两套（L1：说用户的话，不写实现词）。 */
export function fsHintCopy(canControl: boolean): { title: string; sub: string } {
  return canControl
    ? {
        title: "画面偏小，远程鼠标会显得更快",
        sub: "全屏后与对方分辨率更接近，操作更跟手",
      }
    : {
        title: "画面偏小",
        sub: "全屏可以看清对方屏幕细节",
      };
}
