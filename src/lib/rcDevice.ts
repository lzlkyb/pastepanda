/**
 * rcDevice — 远程设备相关的纯函数（头像样式 / 相对时间 / 默认名）。
 *
 * 抽纯函数是为了让 D1(随机色相头像) / D4(上次控制时间) / C4(默认设备名)
 * 的规范判定可单测、可复用，避免同一段逻辑在多组件里各写一份（C10）。
 */

/** 默认配对设备名（C4：RcSection 与 RcOverlay 的统一来源，避免一处「未命名设备」）。 */
export const DEFAULT_RC_DEVICE_NAME = "新设备";

/**
 * 设备头像样式：固定单色系（基于语义 token --accent 派生），不再随机色相。
 * - 任意 node_id（相同或不同）都得到同一颜色 → 一屏一强调色（V3）；
 * - 背景用 color-mix 控浅、文字用深色 token → 对比度达标（WCAG AA，不再 2.5:1）。
 */
export function deviceAvatarStyle(_nodeId: string): { background: string; color: string } {
  return {
    background: "color-mix(in srgb, var(--accent, #4f7cff) 16%, var(--card-bg, #f6f7f9))",
    color: "var(--text-primary, #1c1f23)",
  };
}

/**
 * 相对时间（「上次控制 · 2 小时前」）。
 * 处理 null/undefined/0（视为从未）、未来时间（归为「刚刚」）、刚发生等边界。
 * @param ms 事件时间戳（ms），可能为 null/undefined/0
 * @param now 当前时间戳（ms），默认 Date.now()
 * @returns 中文相对描述；ms 非法时返回空串（调用方据此不显示空文案，D4）
 */
export function relTime(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null || ms <= 0) return "";
  const diff = now - ms;
  if (diff < 0) return "刚刚"; // 未来时间，归为「刚刚」
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  return `${mon} 个月前`;
}
