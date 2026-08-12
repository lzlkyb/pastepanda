/**
 * 免费额度 API（v6.9 签到送 token）。
 *
 * 纯本地记账：初始 10 万 + 签到累计（≤100 万）+ 兑换码（不设上限）。
 * 仅「内置免费（Agnes）」服务商使用，与自配服务商完全隔离。
 */
import { invoke } from "@tauri-apps/api/core";

export interface QuotaInfo {
  deviceId: string;
  /** 总余额（初始 + 签到 + 兑换 - 已用） */
  granted: number;
  /** 签到累计部分 */
  signAdded: number;
  /** 已消耗 */
  spent: number;
  /** 剩余 */
  remaining: number;
  signDate: string | null;
  signStreak: number;
  /** 今天是否还能签到 */
  canSign: boolean;
  todaySpent: number;
  /** 每日用量上限 */
  dailyCap: number;
  /** 签到累计上限（100 万） */
  signCap: number;
  redeemedCount: number;
  /** 连续 7 天累计可得 */
  weekTotal: number;
}

export interface SignResult {
  ok: boolean;
  reward: number;
  streak: number;
  reason: string;
}

export interface RedeemResult {
  ok: boolean;
  amount: number;
  reason: string;
}

/** 额度总览 */
export async function aiQuotaGet(): Promise<QuotaInfo> {
  return invoke("ai_quota_get");
}

/** 每日签到 */
export async function aiQuotaSign(): Promise<SignResult> {
  return invoke("ai_quota_sign");
}

/** 激活兑换码 */
export async function aiQuotaRedeem(code: string): Promise<RedeemResult> {
  return invoke("ai_quota_redeem", { code });
}
