/**
 * challenges.test.ts —— 周挑战推荐（v6.8 粘性 B2）。
 */
import { describe, it, expect } from "vitest";
import { suggestChallenges } from "@/lib/challenges";
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

describe("suggestChallenges", () => {
  it("全新用户：未完成挑战排最前，AI 挑战在首位", () => {
    const list = suggestChallenges(stats());
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list[0].id).toBe("try-ai");
    expect(list.every((c) => !c.done(stats()))).toBe(true);
  });

  it("用过 AI 后：AI 挑战让位，下一个是生成工具", () => {
    const list = suggestChallenges(stats({ aiUsed: true }));
    expect(list[0].id).toBe("try-tool");
  });

  it("全能力齐备：全部标完成，仍返回但 done=true", () => {
    const list = suggestChallenges(
      stats({
        aiUsed: true,
        toolUsed: true,
        triageUsed: true,
        customChainCount: 2,
        profileExported: true,
        profileRefined: true,
      }),
    );
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.done(stats({ aiUsed: true, toolUsed: true, triageUsed: true, customChainCount: 2, profileExported: true, profileRefined: true })))).toBe(true);
  });

  it("最多返回 3 条", () => {
    const list = suggestChallenges(stats({ aiUsed: true, toolUsed: true }));
    expect(list.length).toBeLessThanOrEqual(3);
  });

  it("未完成挑战优先展示（完成的能力不再推荐）", () => {
    // 只完成 try-ai → 前 3 条全是未完成挑战，首条是下一个缺口 try-tool
    const s = stats({ aiUsed: true });
    const list = suggestChallenges(s);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].id).toBe("try-tool");
    expect(list.every((c) => !c.done(s))).toBe(true);
  });
});
