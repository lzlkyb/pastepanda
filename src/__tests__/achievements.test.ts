/**
 * achievements.test.ts —— 成就判定（v6.8 粘性 A3）。
 */
import { describe, it, expect } from "vitest";
import { ACHIEVEMENTS, unlockedIds, unlockedCount, nextAchievement } from "@/lib/achievements";
import type { StickyStats } from "@/lib/api/sticky";

function stats(over: Partial<StickyStats> = {}): StickyStats {
  return {
    calendar: [],
    activeWeekStreak: 0,
    activeDays: 0,
    historyCount: 0,
    firstHistoryAt: null,
    customChainCount: 0,
    aiUsed: false,
    toolUsed: false,
    triageUsed: false,
    profileExported: false,
    profileRefined: false,
    ...over,
  };
}

describe("成就定义完整性", () => {
  it("成就数 ≥ 8，id 唯一，全部有判定", () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
    expect(ids.size).toBe(ACHIEVEMENTS.length);
    for (const a of ACHIEVEMENTS) {
      expect(typeof a.unlocked).toBe("function");
      expect(a.name.length).toBeGreaterThan(0);
    }
  });

  it("空数据一个都不解锁", () => {
    const s = stats();
    expect(unlockedCount(s)).toBe(0);
    expect(unlockedIds(s).size).toBe(0);
  });
});

describe("成就判定规则", () => {
  it("第一次飞跃：aiUsed", () => {
    expect(unlockedIds(stats({ aiUsed: true }))).toContain("first-ai");
    expect(unlockedIds(stats({ aiUsed: false }))).not.toContain("first-ai");
  });

  it("结构化人生：toolUsed（生成工具）", () => {
    expect(unlockedIds(stats({ toolUsed: true }))).toContain("structured");
  });

  it("我会排错：triageUsed", () => {
    expect(unlockedIds(stats({ triageUsed: true }))).toContain("triage");
  });

  it("方法论之父：customChainCount ≥ 1", () => {
    expect(unlockedIds(stats({ customChainCount: 1 }))).toContain("chain-creator");
    expect(unlockedIds(stats({ customChainCount: 0 }))).not.toContain("chain-creator");
  });

  it("可移植的灵魂：profileExported", () => {
    expect(unlockedIds(stats({ profileExported: true }))).toContain("portable");
  });

  it("百炼成钢：historyCount ≥ 10 万", () => {
    expect(unlockedIds(stats({ historyCount: 99_999 }))).not.toContain("bronze");
    expect(unlockedIds(stats({ historyCount: 100_000 }))).toContain("bronze");
  });

  it("老兵不死：activeWeekStreak ≥ 12", () => {
    expect(unlockedIds(stats({ activeWeekStreak: 11 }))).not.toContain("veteran");
    expect(unlockedIds(stats({ activeWeekStreak: 12 }))).toContain("veteran");
  });

  it("画像觉醒：profileRefined", () => {
    expect(unlockedIds(stats({ profileRefined: true }))).toContain("awakening");
  });

  it("全解锁后 nextAchievement 为 null", () => {
    const s = stats({
      aiUsed: true,
      toolUsed: true,
      triageUsed: true,
      customChainCount: 1,
      profileExported: true,
      historyCount: 100_000,
      activeWeekStreak: 12,
      profileRefined: true,
    });
    expect(unlockedCount(s)).toBe(ACHIEVEMENTS.length);
    expect(nextAchievement(s)).toBeNull();
  });

  it("nextAchievement 返回第一个未解锁成就", () => {
    const s = stats({ aiUsed: true });
    const next = nextAchievement(s);
    expect(next?.id).toBe("structured");
  });
});
