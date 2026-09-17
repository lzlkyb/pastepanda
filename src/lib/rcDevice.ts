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

/** 设备可达性档位（与后端 `RcPresence` 同构）。 */
export type RcPresenceLevel = "live" | "recent" | "seen" | "never";

/**
 * 设备行主状态文案（设计稿：多档，不冒充有中心服务器的二值绿点）。
 * 纯函数便于单测；`lastSeen` 为 `relTime` 已格式化串。
 */
export function presenceMainLabel(
  presence: RcPresenceLevel,
  lastSeenLabel: string,
): string {
  switch (presence) {
    case "live":
      return "在线";
    case "recent":
      return lastSeenLabel ? `${lastSeenLabel}还在` : "刚刚还在";
    case "seen":
      return lastSeenLabel ? `${lastSeenLabel}见过` : "见过";
    case "never":
    default:
      return "配对后还没连上过";
  }
}

/** 设备行状态点的 CSS module 类名键。 */
export function presenceDotClass(
  presence: RcPresenceLevel,
): "dotOn" | "dotRecent" | "dotOff" {
  if (presence === "live") return "dotOn";
  if (presence === "recent") return "dotRecent";
  return "dotOff";
}

/** 设备行尾部补充说明（可操作，不是重复主文案）。 */
export function presenceHint(presence: RcPresenceLevel): string {
  switch (presence) {
    case "live":
      return "局域网可达";
    case "recent":
      return "仍可尝试";
    case "seen":
      return "仍可经中继尝试";
    case "never":
    default:
      return "核对指纹后再试，或检查对方远程通道";
  }
}
