/**
 * api/aiFeedback.ts — AI 结果反馈 + 动作偏好指令（M3 偏好学习）。
 * 对应 Rust：data_store/ai_feedback.rs + commands/ai_feedback.rs。
 *
 * 只传信号（accepted/edited + 结果哈希），**永远不传内容文本**（红线）。
 */

import { invoke } from "@tauri-apps/api/core";

export type AiFeedbackOutcome = "accepted" | "edited" | "rejected";

export interface AiFeedback {
  actionId: string;
  /** 内容类型（`json` / `code` / `text` …）；可空 */
  contentType?: string;
  outcome: AiFeedbackOutcome;
  /** 产物哈希（去重统计用） */
  resultHash?: string;
}

/** 按动作聚合的反馈统计 */
export interface AiFeedbackStat {
  actionId: string;
  total: number;
  accepted: number;
  edited: number;
  rejected: number;
  /** edited / total，0~1 */
  editRate: number;
}

/** 一条动作偏好指令 */
export interface ActionPrefRow {
  actionId: string;
  preference: string;
  updatedAt: string;
}

export const aiFeedbackAdd = (feedback: AiFeedback) =>
  invoke<void>("ai_feedback_add", { feedback });

export const aiFeedbackStats = (days?: number) =>
  invoke<AiFeedbackStat[]>("ai_feedback_stats", { days });

export const aiFeedbackClear = () => invoke<number>("ai_feedback_clear");

export const actionPrefGet = (actionId: string) =>
  invoke<string>("action_pref_get", { actionId });

export const actionPrefSet = (actionId: string, preference: string) =>
  invoke<void>("action_pref_set", { actionId, preference });

export const actionPrefsAll = () => invoke<ActionPrefRow[]>("action_prefs_all");

/** 产物去重用简单散列（djb2，非加密级——够统计"同款结果被改过几次"） */
export function hashResult(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
