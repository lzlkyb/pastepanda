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

// ============================================================
// 偏好自荐：特征信号 → 待确认的偏好建议
// 对应 Rust：data_store/pref_signals.rs
// ============================================================

/** 一条“可以提议了”的信号（未达阈值 / 已处理 → 后端返 null） */
export interface PrefSignalTop {
  actionId: string;
  /** 特征标签，取值见 lib/prefLearn.ts 的 PrefFeature */
  feature: string;
  count: number;
}

/**
 * 上报特征标签。**只传枚举标签，不传任何内容**（后端还会再校一次白名单）。
 * fire-and-forget：记账失败不能影响用户复制产物。
 */
export const prefSignalAdd = (actionId: string, features: string[]) =>
  invoke<void>("pref_signal_add", { actionId, features });

export const prefSignalTop = (actionId: string) =>
  invoke<PrefSignalTop | null>("pref_signal_top", { actionId });

/**
 * 用户点「记住」：写入偏好 + 标记已处理 + 清 AI 缓存，**后端一个命令内完成**。
 * 不要拆成 actionPrefSet + prefSignalDismiss 两次调用——中间断了就会变成
 * “偏好已生效但建议接着弹”。
 */
export const prefSignalAccept = (actionId: string, feature: string, preference: string) =>
  invoke<void>("pref_signal_accept", { actionId, feature, preference });

export const prefSignalDismiss = (actionId: string, feature: string) =>
  invoke<void>("pref_signal_dismiss", { actionId, feature });

export const prefSignalClear = () => invoke<number>("pref_signal_clear");

/** 产物去重用简单散列（djb2，非加密级——够统计"同款结果被改过几次"） */
export function hashResult(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
