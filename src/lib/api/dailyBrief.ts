/**
 * 每日整理 API（H3 行为层）——对应 `commands/history.rs` 的 `history_day_meta`。
 *
 * **不存任何东西**：行为层每次打开实时算。
 * 唯一会写入的是 AI 小结，而它走已有的「存入今日速记」路径（`note_daily_append`）。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import type { SegmentItem } from "@/lib/events";

/** 后端只返这五列，刚好就是分段需要的形状。 */
export type DayMetaRow = SegmentItem;

/**
 * 拉某一天的条目元信息（`YYYY-MM-DD`），已按时间升序。
 *
 * 失败返空数组而不抛：调用方拿空数组会自然落到冷启动态，
 * 比弹一个错误弹窗强——用户只是想看一眼今天干了啥。
 */
export async function historyDayMeta(date: string): Promise<DayMetaRow[]> {
  try {
    return await invoke<DayMetaRow[]>("history_day_meta", { date });
  } catch (e) {
    logger.warn("读当日元信息失败", e);
    return [];
  }
}

/**
 * 最近 N 条的条目元信息（事件聚合 G3），已按时间升序。
 *
 * 不传 `limit` 就用后端的上限（`RECENT_META_CAP`）。
 * 与 [`historyDayMeta`] 同一批五列，区别只在圈定范围的方式。
 */
export async function historyRecentMeta(limit?: number): Promise<DayMetaRow[]> {
  try {
    return await invoke<DayMetaRow[]>("history_recent_meta", { limit: limit ?? null });
  } catch (e) {
    logger.warn("读最近元信息失败", e);
    return [];
  }
}

/** `Date` → `YYYY-MM-DD`（**本地时区**）。 */
export function toIsoDate(d: Date): string {
  // 不用 `toISOString()`：那个转 UTC，东八区凌晨一点看到的会是前一天，
  // 而「今天」对日报来说必须是本地的今天。
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 前一天的 `YYYY-MM-DD`。 */
export function prevDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return toIsoDate(dt);
}

/**
 * 冷启动判据：**不足两段就是冷启动**。
 *
 * 🔴 故意不用条数阈值。周报那个 `WEEK_REPORT_MIN_EVENTS = 50` 照搬不得——
 * 真库近 7 天有 4 天不足 50 条，照搬就是大半数天打开都是冷启动面。
 * 而「分不出两段事」本身就是「今天没什么好整理」的定义，不用另拍一个数字。
 */
export const MIN_SEGMENTS = 2;
