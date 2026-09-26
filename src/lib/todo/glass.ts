/**
 * 岛玻璃遮盖度（2026-09-26：四档枚举 → 连续滑杆）。
 *
 * 唯一口径是这个数怎么变成合法的 20–100 整数，三个消费方共用：
 * 设置页滑杆读数、岛前端写 CSS 变量、appStore 的旧值迁移。
 * 越界/旧字符串/手改 config 全都从 `normalizeGlass` 一个口子过（规则 11.1）。
 */

export const GLASS_MIN = 20;
/** 100 = 完全不透（路线一「承认岛不该透」的终点），上限即用户可把岛拖成全实色 */
export const GLASS_MAX = 100;
/** 默认 95：近不透，任何桌面背景下文字都清楚；原「厚磨砂 frost」= 78 只是取样点之一 */
export const GLASS_DEFAULT = 95;

/** 旧四档 → 遮盖度，取值与原 TodoIsland.module.css 的四档 tint α 逐一对应 */
const LEGACY_TIER: Record<string, number> = { clear: 30, frost: 78, steady: 90, dark: 92 };

/** 任意来源的值 → 合法的 20–100 整数；认不出来（旧档位名之外的字符串、null、越界非数字）落默认档。 */
export function normalizeGlass(raw: unknown): number {
  const v = typeof raw === "number" ? raw : typeof raw === "string" ? LEGACY_TIER[raw] : undefined;
  if (v === undefined || !Number.isFinite(v)) return GLASS_DEFAULT;
  return Math.round(Math.min(GLASS_MAX, Math.max(GLASS_MIN, v)));
}
