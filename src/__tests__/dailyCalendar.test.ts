/**
 * 今日速记日历（B2 #3）的日期逻辑。
 *
 * 钉的都是看界面验不完的分支：月首星期几、行数自适应、跨年翻月、
 * 闰年二月，以及那个最容易造成“整体错一天”的时区坑。
 */
import { describe, it, expect } from "vitest";
import {
  canGoNext,
  canGoPrev,
  fmtDate,
  monthGrid,
  monthOf,
  shiftMonth,
} from "@/lib/dailyCalendar";

describe("fmtDate", () => {
  it("用本地时间，不是 UTC", () => {
    // 东八区的 9/1 00:00 用 toISOString() 会变成 2026-08-31，
    // 那会让整个日历错一天、而且只在晚上才能复现
    expect(fmtDate(new Date(2026, 8, 1, 0, 0, 0))).toBe("2026-09-01");
    expect(fmtDate(new Date(2026, 8, 1, 23, 59, 59))).toBe("2026-09-01");
  });

  it("个位月份/日期补零", () => {
    expect(fmtDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("monthOf / shiftMonth", () => {
  it("取月份前缀", () => {
    expect(monthOf("2026-09-01")).toBe("2026-09");
  });

  it("跨年往前翻", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("跨年往后翻", () => {
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
  });

  it("连翻多个月", () => {
    expect(shiftMonth("2026-03", -5)).toBe("2025-10");
  });
});

describe("monthGrid", () => {
  it("周一开头：2026-09-01 是周二，所以前面只补一格", () => {
    const cells = monthGrid("2026-09");
    expect(cells[0].date).toBe("2026-08-31");
    expect(cells[0].inMonth).toBe(false);
    expect(cells[1].date).toBe("2026-09-01");
    expect(cells[1].inMonth).toBe(true);
  });

  it("格子总数总是 7 的倍数（不然最后一行会碎）", () => {
    for (const m of ["2026-01", "2026-02", "2026-09", "2027-05"]) {
      expect(monthGrid(m).length % 7).toBe(0);
    }
  });

  it("行数自适应，不固定 42 格", () => {
    // 2026-02 有28 天且 2/1 是周日 → 前面补0……总之不该恒为 42
    const lens = ["2026-01", "2026-02", "2026-09"].map((m) => monthGrid(m).length);
    expect(lens.some((n) => n < 42)).toBe(true);
  });

  it("闰年二月含 29 日", () => {
    const days = monthGrid("2028-02").filter((c) => c.inMonth);
    expect(days.length).toBe(29);
    expect(days[days.length - 1].date).toBe("2028-02-29");
  });

  it("平年二月含 28 日", () => {
    expect(monthGrid("2026-02").filter((c) => c.inMonth).length).toBe(28);
  });

  it("当月格子的日期连续且全属本月", () => {
    const inMonth = monthGrid("2026-09").filter((c) => c.inMonth);
    expect(inMonth[0].date).toBe("2026-09-01");
    expect(inMonth[inMonth.length - 1].date).toBe("2026-09-30");
    expect(inMonth.every((c) => c.date.startsWith("2026-09"))).toBe(true);
  });
});

describe("翻页边界", () => {
  it("没有任何速记时不能往前翻", () => {
    expect(canGoPrev("2026-09", null)).toBe(false);
  });

  it("翻到最早一条所在月就到头", () => {
    expect(canGoPrev("2026-08", "2026-07-15")).toBe(true);
    expect(canGoPrev("2026-07", "2026-07-15")).toBe(false);
    expect(canGoPrev("2026-06", "2026-07-15")).toBe(false);
  });

  it("未来没有速记，本月就是头", () => {
    expect(canGoNext("2026-08", "2026-09-01")).toBe(true);
    expect(canGoNext("2026-09", "2026-09-01")).toBe(false);
  });
});
