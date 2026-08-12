/**
 * milestones.test.ts —— 里程碑判定与已读状态（v6.8 粘性 B1）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { checkMilestones, milestoneSeen, markMilestoneSeen, HUNDRED_K } from "@/lib/milestones";
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

/** N 年前的日期字符串（"YYYY-MM-DD HH:MM:SS"），多退 1 天以落在周年后的窗口内 */
function yearsAgo(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  d.setDate(d.getDate() - 1);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`;
}

function aYearAgo(): string {
  return yearsAgo(1);
}

describe("checkMilestones", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("空数据不触发任何里程碑", () => {
    expect(checkMilestones(stats())).toBeNull();
  });

  it("画像觉醒优先触发（profileRefined）", () => {
    const m = checkMilestones(stats({ profileRefined: true, historyCount: 200_000 }));
    expect(m?.kind).toBe("awakening");
  });

  it("第 10 万次复制触发 hundred-k，低于阈值不触发", () => {
    expect(checkMilestones(stats({ historyCount: HUNDRED_K - 1 }))).toBeNull();
    const m = checkMilestones(stats({ historyCount: HUNDRED_K }));
    expect(m?.kind).toBe("hundred-k");
  });

  it("使用满一年触发 anniversary", () => {
    const m = checkMilestones(stats({ firstHistoryAt: aYearAgo() }));
    expect(m?.kind).toBe("anniversary");
    expect(m?.title).toContain("1 年");
  });

  it("第 2 / 第 3 周年也能触发，且期次（stamp）逐年不同", () => {
    // 回归：旧实现窗口是 `daysUsed >= 365 && < 395`，第 2 周年（≈730 天）
    // 直接不满足 → 多周年永远触发不了；且 stamp 恒为“首年+1”。
    const m2 = checkMilestones(stats({ firstHistoryAt: yearsAgo(2) }));
    expect(m2?.kind).toBe("anniversary");
    expect(m2?.stamp).toBe("2");
    expect(m2?.title).toContain("2 年");

    const m3 = checkMilestones(stats({ firstHistoryAt: yearsAgo(3) }));
    expect(m3?.stamp).toBe("3");
    expect(m3?.title).toContain("3 年");

    // 期次不同 → 第 2 周年标已读不会让第 3 周年被吞掉
    markMilestoneSeen("anniversary", "2");
    expect(checkMilestones(stats({ firstHistoryAt: yearsAgo(2) }))).toBeNull();
    expect(checkMilestones(stats({ firstHistoryAt: yearsAgo(3) }))?.stamp).toBe("3");
  });

  it("周年后超过 30 天不再触发", () => {
    // 周年日已过 60 天：落在窗口外
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    d.setDate(d.getDate() - 60);
    const p = (x: number) => String(x).padStart(2, "0");
    const old = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`;
    expect(checkMilestones(stats({ firstHistoryAt: old }))).toBeNull();
  });

  it("未满一年不触发 anniversary", () => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    const p = (n: number) => String(n).padStart(2, "0");
    const halfYear = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`;
    expect(checkMilestones(stats({ firstHistoryAt: halfYear }))).toBeNull();
  });

  it("已读状态：触发过的里程碑不再重复返回", () => {
    const s = stats({ historyCount: HUNDRED_K });
    const first = checkMilestones(s);
    expect(first?.kind).toBe("hundred-k");
    markMilestoneSeen(first!.kind, first!.stamp);
    expect(checkMilestones(s)).toBeNull();
    expect(milestoneSeen(first!.kind, first!.stamp)).toBe(true);
  });
});
