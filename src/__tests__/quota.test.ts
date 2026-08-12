/**
 * quota.test.ts —— 免费额度业务逻辑（v6.9 签到阶梯）。
 */
import { describe, it, expect } from "vitest";
import { rewardOf, ladderCells, weekTotal, SIGN_BASE, SIGN_STEP, SIGN_MAX } from "@/lib/quota";
import type { QuotaInfo } from "@/lib/api/quota";

function stats(over: Partial<QuotaInfo> = {}): QuotaInfo {
  return {
    deviceId: "t",
    granted: 100_000,
    signAdded: 0,
    spent: 0,
    remaining: 100_000,
    signDate: null,
    signStreak: 0,
    canSign: true,
    todaySpent: 0,
    dailyCap: 100_000,
    signCap: 1_000_000,
    redeemedCount: 0,
    weekTotal: 290_000,
    ...over,
  };
}

describe("rewardOf（签到奖励阶梯）", () => {
  it("第 1 天 2 万，每天 +1 万，第 4 天起封顶 5 万", () => {
    expect(rewardOf(1)).toBe(SIGN_BASE);
    expect(rewardOf(2)).toBe(SIGN_BASE + SIGN_STEP);
    expect(rewardOf(3)).toBe(SIGN_BASE + 2 * SIGN_STEP);
    expect(rewardOf(4)).toBe(SIGN_MAX);
    expect(rewardOf(7)).toBe(SIGN_MAX);
    expect(rewardOf(100)).toBe(SIGN_MAX);
  });

  it("连续 7 天累计 = 29 万", () => {
    expect(weekTotal()).toBe(29_0000);
  });
});

describe("ladderCells（7 格签到阶梯）", () => {
  it("未签（streak=0）：今天第 1 天 + 未来 6 格 = 7 格", () => {
    const cells = ladderCells(stats());
    expect(cells).toHaveLength(7);
    expect(cells[0].today).toBe(true);
    expect(cells[0].done).toBe(false);
    expect(cells[0].reward).toBe(SIGN_BASE);
    expect(cells.filter((c) => c.future)).toHaveLength(6);
  });

  it("连续 3 天未签今天：3 格已签 + 今天第 4 天 + 3 格未来", () => {
    const cells = ladderCells(stats({ signStreak: 3 }));
    expect(cells).toHaveLength(7);
    expect(cells.filter((c) => c.done)).toHaveLength(3);
    const today = cells.find((c) => c.today)!;
    expect(today.label).toBe("今天");
    expect(today.reward).toBe(SIGN_MAX); // 第 4 天封顶
  });

  it("今日已签（canSign=false, streak=4）：今天格为已签", () => {
    const cells = ladderCells(stats({ canSign: false, signStreak: 4 }));
    const today = cells.find((c) => c.today)!;
    expect(today.done).toBe(true);
    // 回顾 3 格（第1-3天）+ 今天 + 未来 3 格 = 7
    expect(cells.filter((c) => c.done)).toHaveLength(4);
    expect(cells.filter((c) => c.future)).toHaveLength(3);
  });

  it("永远恰好 7 格（回顾最多 3）", () => {
    for (const streak of [0, 1, 5, 20]) {
      expect(ladderCells(stats({ signStreak: streak }))).toHaveLength(7);
    }
  });
});
