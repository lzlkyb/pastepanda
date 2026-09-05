/**
 * 日期工具的用例。看着琐碎，但跨月跨年与时区是日报最容易静默出错的两处：
 * 算错一天不会报错，只会让用户看到另一天的数据而不自知。
 */
import { describe, it, expect } from "vitest";
import { toIsoDate, prevDay, MIN_SEGMENTS } from "@/lib/api/dailyBrief";

describe("toIsoDate", () => {
  it("补零到两位", () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(toIsoDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("用**本地**日期，不是 UTC", () => {
    // 东八区凌晨 00:30 的 toISOString() 会给出前一天，
    // 而「今天的整理」必须是本地的今天。
    const d = new Date(2026, 8, 5, 0, 30);
    expect(toIsoDate(d)).toBe("2026-09-05");
  });
});

describe("prevDay", () => {
  it("普通情况", () => {
    expect(prevDay("2026-09-05")).toBe("2026-09-04");
  });

  it("跨月", () => {
    expect(prevDay("2026-09-01")).toBe("2026-08-31");
    expect(prevDay("2026-03-01")).toBe("2026-02-28");
  });

  it("跨年", () => {
    expect(prevDay("2026-01-01")).toBe("2025-12-31");
  });

  it("闰年（2024-03-01 的前一天是 02-29）", () => {
    expect(prevDay("2024-03-01")).toBe("2024-02-29");
  });

  it("连续往回翻不会跑偏", () => {
    let d = "2026-03-02";
    for (let i = 0; i < 5; i++) d = prevDay(d);
    expect(d).toBe("2026-02-25");
  });
});

describe("MIN_SEGMENTS", () => {
  it("是 2（不足两段就是冷启动）", () => {
    // 刷成条数阈值就会重蹈周报的覆辙：真库近 7 天有 4 天不足 50 条。
    expect(MIN_SEGMENTS).toBe(2);
  });
});
