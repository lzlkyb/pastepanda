import type { Rect } from "./snap";

/**
 * 倒计时（只盖选区）；「取消」是这一态唯一的鼠标出口（§17：键盘只是加速器）。
 *
 * 2026-10-16 苹果风重做（设计稿 §2）：
 * ① 加一圈 **3 秒走完的 SVG 进度环**——原来只有一个 72px 白数字，读不出「还剩多久」；
 * ② 数字换帧靠 `key={count}` 重挂载触发 `tickPop 200ms`（旧实现是每秒硬替换）；
 * ③ 读数只报尺寸：「将录制：」前缀与「按 Esc 回到选区」整行删掉（§5.1）——
 *    键位由条上的 `?` 与全局快捷键承载，不值得在倒计时里常驻一行。
 *
 * 🔴 两层底（`rec-countdown` 的暗罩与两枚胶囊的玻璃底）与「取消」的字色都**不许**改成
 * 裸色：改前 `color:#fff` 直接压在 rgba(10,14,24,.28) 的半透明层上、底下是用户桌面，
 * 白壁纸上大概率塌（2026-10-10 审查 P2）。字色对由 recGlassContrastGuard 逐主题现算。
 */
const RING_R = 42;
/** 周长 2πr，保留两位（263.8937…）；dasharray 与 keyframes 的终点必须取同一个值。 */
const RING_C = 263.89;

export function CountdownOverlay({ rect, count, readout, onCancel }: {
  rect: Rect; count: number; readout: string; onCancel: () => void;
}) {
  return (
    <div
      className="rec-countdown"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} /* ui-rule-ok: 倒计时覆盖动态选区，几何值不能放入静态样式 */
    >
      <span className="rec-count-target">{readout}</span>
      <span className="rec-count-ring" aria-hidden="true">
        <svg viewBox="0 0 96 96">
          <circle className="track" cx="48" cy="48" r={RING_R} />
          <circle className="sweep" cx="48" cy="48" r={RING_R} strokeDasharray={RING_C} />
        </svg>
        {/* key 变化 = 重挂载 = tickPop 重播；数字不动时不会有多余动画 */}
        <span key={count} className="num">{Math.max(1, count)}</span>
      </span>
      <button type="button" className="rec-count-cancel" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
