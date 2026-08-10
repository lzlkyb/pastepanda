/**
 * api/profile.ts — 用户画像（M6-2/M6-3）。
 * 对应 Rust：commands/profile.rs + data_store/profile.rs。
 *
 * 画像 = 纯函数(现有行为数据) + 用户覆盖，只含统计值不含内容。
 */

import { invoke } from "@tauri-apps/api/core";

export interface RoleScore {
  role: string;
  label: string;
  score: number;
}

export interface DomainShare {
  domain: string;
  pct: number;
}

export interface TopAction {
  actionId: string;
  count: number;
}

export interface HourSegment {
  label: string;
  pct: number;
}

export interface PrefItem {
  actionId: string;
  preference: string;
  editRate: number;
}

export interface UserProfile {
  roleScores: RoleScore[];
  domains: DomainShare[];
  topActions: TopAction[];
  hours: HourSegment[];
  prefs: PrefItem[];
  overrides: Record<string, string>;
  sampleEvents: number;
  confidence: number;
}

/** 画像导出格式 */
export type ProfileFormat = "md" | "json" | "skill";
/** 导出大类（copy-my-profile 5 大类，identity 由用户自填略过） */
export type ProfileCategory = "profession" | "projects" | "preferences" | "instructions";

export function profileGet(): Promise<UserProfile> {
  return invoke("profile_get");
}

export function profileSetOverride(key: string, value: string): Promise<void> {
  return invoke("profile_set_override", { key, value });
}

/** 导出画像文本（md / json / skill 均为字符串产物） */
export function profileExport(
  format: ProfileFormat,
  categories: ProfileCategory[],
): Promise<string> {
  return invoke("profile_export", { format, categories });
}

/** 一键安装为 Claude Code / Cursor skill，返回安装目录 */
export function profileInstallSkill(): Promise<string> {
  return invoke("profile_install_skill");
}

/**
 * LLM 精炼画像（V3-C）：把统计画像润色成自然语言描述。
 * 出网内容 = 纯统计值（角色/领域/动作 id/时段/偏好），过敏感清洗 + 日预算。
 */
export const profileRefine = () => invoke<string>("profile_refine");

/** 一条画像驱动的推荐加成 */
export interface ActionBoost {
  actionId: string;
  boost: number;
}

/** 画像驱动的推荐加成表（角色 → 擅长动作） */
export function profileActionBoosts(): Promise<ActionBoost[]> {
  return invoke("profile_action_boosts");
}
