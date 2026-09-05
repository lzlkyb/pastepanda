/**
 * 事件标签与 `range:` 筛选值的用例。
 *
 * 相对日期那几条不是挑剔：《事件聚合设计稿》§3 ④ 是拿真实数据跑出来才发现的
 * ——今天的事件带日期前缀是纯噪音。
 *
 * 所有函数都把「现在」作为参数传入而不是 `new Date()`，
 * 否则跨午夜跑测试会间歇红（且无法重现）。
 */
import { describe, it, expect } from "vitest";
import { eventLabel, eventRangeValue, parseEventRange } from "@/lib/eventLabel";
import { segmentByGap, EVENT_GAP_SECS, type SegmentItem } from "@/lib/events";

function seg(day: string, times: string[], source = "Excel") {
  const items: SegmentItem[] = times.map((t) => ({
    id: `${day} ${t}`,
    time: `${day} ${t}`,
    source,
    type: "text",
    content_type: null,
  }));
  return segmentByGap(items, EVENT_GAP_SECS)[0];
}

/** 固定的「现在」：2026-09-05 18:00 */
const NOW = new Date(2026, 8, 5, 18, 0, 0);

describe("eventLabel · 相对日期", () => {
  it("今天的事件**不带日期前缀**", () => {
    // 设计稿 §3 ④：今天的事件带日期是纯噪音。
    // ❗ 段内相邻间隔必须 ≤ 20 分钟，否则 segmentByGap 会把它们拆成两段
    const s = seg("2026-09-05", ["14:59:00", "15:10:00", "15:28:00", "15:46:00"]);
    expect(eventLabel(s, NOW)).toBe("14:59-15:46 · Excel · 4 条");
  });

  it("昨天的事件显示「昨天」而不是日期", () => {
    const s = seg("2026-09-04", ["18:35:00", "18:40:00"]);
    expect(eventLabel(s, NOW)).toBe("昨天 18:35-18:40 · Excel · 2 条");
  });

  it("更早的才显示日期", () => {
    const s = seg("2026-08-11", ["09:20:00", "09:35:00"]);
    expect(eventLabel(s, NOW)).toBe("8-11 09:20-09:35 · Excel · 2 条");
  });

  it("跨月的昨天也认得出来", () => {
    const s = seg("2026-08-31", ["10:00:00", "10:05:00"]);
    const now = new Date(2026, 8, 1, 9, 0, 0); // 9-1
    expect(eventLabel(s, now)).toContain("昨天");
  });
});

describe("eventLabel · 单条段", () => {
  it("只写一个时间点，不写 12:39-12:39", () => {
    const s = seg("2026-09-05", ["12:39:00"]);
    expect(eventLabel(s, NOW)).toBe("12:39 · Excel · 1 条");
  });
});

describe("eventRangeValue / parseEventRange", () => {
  it("构造的值能被自己解回来", () => {
    const s = seg("2026-09-05", ["14:59:00", "15:10:00"]);
    const v = eventRangeValue(s);
    expect(v).toBe("range:2026-09-05 14:59:00~2026-09-05 15:10:00");
    expect(parseEventRange(v)).toEqual({
      start: "2026-09-05 14:59:00",
      end: "2026-09-05 15:10:00",
    });
  });

  it("范围用**秒级原始时间**而不是展示用的 HH:MM", () => {
    // 拿 HH:MM 去筛会把首尾那一分钟内的条目漏掉或多包
    const s = seg("2026-09-05", ["14:59:37", "15:10:02"]);
    expect(eventRangeValue(s)).toContain("14:59:37");
    expect(eventRangeValue(s)).toContain("15:10:02");
  });

  it("不是 range 的值解出 null", () => {
    expect(parseEventRange("today")).toBeNull();
    expect(parseEventRange("all")).toBeNull();
    expect(parseEventRange("range:残缺的")).toBeNull();
  });
});
