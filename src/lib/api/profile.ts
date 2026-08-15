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

/**
 * 一键安装为 Claude Code skill，返回安装目录。
 * （旧注释写的是“Claude Code / Cursor”，但后端只拼 `~/.claude/skills`，不碰其它工具。）
 *
 * categories 与 {@link profileExport} 同义：不传 = 全部，空数组 = 一个都不要。
 * 只影响 SKILL.md；references/profile.json 始终是完整快照（和 skill 预览里那份一致）。
 */
export function profileInstallSkill(
  categories: ProfileCategory[],
): Promise<string> {
  return invoke("profile_install_skill", { categories });
}

/**
 * 工作流技能包（v6.4 S1）：把自定义 AI 动作 + 动作链打包成 SKILL.md，
 * 装进 ~/.claude/skills/pastepanda-workflows/（26+ 平台可调用）。
 */
/** 工作流导出结果：装到哪了 + 因含敏感信息被跳过几条 */
export type SkillInstallResult = { path: string; skipped: number };

/**
 * 把自定义动作/动作链导出为 skill。
 * 后端会把含密钥/个人信息的条目整条剔除（导出物会被外部 AI 工具自动读取），
 * `skipped > 0` 时必须告知用户，否则他会以为动作丢了。
 */
export const skillInstallWorkflows = () => invoke<SkillInstallResult>("skill_install_workflows");

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

/** 即将拼进 system prompt 的画像片段（D1 预览） */
export interface ProfilePromptPreview {
  /** 片段原文。空 = 本次不会注入任何东西 */
  text: string;
  /** 字符数 */
  chars: number;
  /** 片段非空却被出网闸整条拦下（开了开关却什么都没发，必须让用户看见） */
  blocked: boolean;
  /** 当前样本量 */
  sampleEvents: number;
  /** 注入门槛（前端不硬写数字，后端改了这里跟着变） */
  minEvents: number;
}

/**
 * 预览画像注入片段。
 *
 * 拿到的就是 `ai_run` 实际拼进去的那串字符（同一个函数、同一个统计窗口），
 * 不是另外生成的描述——这是该功能默认开的前提。
 */
export function profilePromptPreview(): Promise<ProfilePromptPreview> {
  return invoke("profile_prompt_preview");
}
