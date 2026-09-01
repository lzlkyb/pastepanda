/**
 * 今日速记（B2 #3 / D11）的前端 API。
 *
 * 两个入口（全局热键 / 卡片右键菜单）都走 `noteAppendDaily`——
 * 日期归一化、重复判定、首次创建全在后端一处（规则 #11）。
 *
 * 🔴 红线：无 AI。速记只在本机内存 ↔ 本机 SQLite 之间走。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import type { Note } from "./notes";

/**
 * 追加结果。
 *
 * `duplicate` **不是错误**：它表示内容与上一段完全相同、后端没写库，
 * 需要前端说一句「这条刚记过」——热键手滑连按两下是常态。
 * 形状同 `AiRunResponse`：Rust 那边是 internally tagged 枚举，
 * `appended` 会把 Note 的字段**展平**到同一层。
 */
export type DailyAppend = ({ status: "appended" } & Note) | { status: "duplicate" };

/**
 * 往今天那条速记追加一段。失败返回 null（调用方负责提示）。
 *
 * 失败**不在这里弹 toast**：两个入口的提示位置不同（热键走托盘、
 * 右键菜单走窗口内 toast），写在这里反而强行统一了。
 */
export async function noteAppendDaily(
  text: string,
  source?: string | null,
): Promise<DailyAppend | null> {
  try {
    return await invoke<DailyAppend>("note_append_daily", { text, source: source ?? null });
  } catch (e) {
    logger.warn("追加今日速记失败", e);
    return null;
  }
}

/** 某月有速记的日期（`month` 形如 `2026-09`）。日历打点用。 */
export async function noteDailyDates(month: string): Promise<string[]> {
  try {
    return await invoke<string[]>("note_daily_dates", { month });
  } catch (e) {
    logger.warn("读速记日期失败", e);
    return [];
  }
}

/** 最早一条速记的日期。日历翻到头就置灰「‹」。 */
export async function noteDailyEarliest(): Promise<string | null> {
  try {
    return await invoke<string | null>("note_daily_earliest");
  } catch (e) {
    logger.warn("读最早速记日期失败", e);
    return null;
  }
}

/** 今天那条速记（没有则 null）。 */
export async function noteDailyToday(): Promise<Note | null> {
  try {
    return await invoke<Note | null>("note_daily_today");
  } catch (e) {
    logger.warn("读今日速记失败", e);
    return null;
  }
}
