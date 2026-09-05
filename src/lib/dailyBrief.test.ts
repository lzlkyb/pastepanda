/**
 * 每日整理纯函数的用例。
 *
 * 重心是 `briefToText` 的**隐私断言**：它是唯一会把数据送出网的地方，
 * 一旦有人为了「让小结更准」把正文拼进去，这里要立刻拦住。
 */
import { describe, it, expect } from "vitest";
import { briefToText, dayTitle } from "@/lib/dailyBrief";
import { segmentByGap, EVENT_GAP_SECS, type SegmentItem } from "@/lib/events";

/** 造一条带敏感内容的条目——分段只拿五列，本来就没有 text 字段 */
function row(t: string, source: string, type = "text"): SegmentItem {
  return { id: t, time: `2026-09-04 ${t}`, source, type, content_type: null };
}

describe("briefToText · 隐私", () => {
  it("只包含数字与来源名，不包含任何条目 id", () => {
    const segs = segmentByGap(
      [row("09:00:00", "Edge"), row("09:05:00", "Edge")],
      EVENT_GAP_SECS,
    );
    const text = briefToText("2026-09-04", segs, [["text", 2]]);
    // id 在本用例里是时间串，但真实场景里是 UUID——都不应该出现
    expect(text).not.toContain("09:00:00");
    expect(text).toContain("Edge");
    expect(text).toContain("2 条");
  });

  it("段内条目本体不被序列化进去", () => {
    const segs = segmentByGap([row("09:00:00", "Edge")], EVENT_GAP_SECS);
    const text = briefToText("2026-09-04", segs, [["text", 1]]);
    // 如果有人改成 JSON.stringify(segments)，items 会整个进去
    expect(text).not.toContain("items");
    expect(text).not.toContain("{");
  });

  it("窗口标题里的文档名不会泄露（已经过归一化）", () => {
    // source 存的是完整窗口标题，里面可能带文件名/页面标题这类信息。
    // 分段时已经过 cleanSourceName 取了最后一段，所以只剩应用名。
    const segs = segmentByGap(
      [
        row("09:00:00", "工资表 2026年度机密.xlsx - Excel"),
        row("09:05:00", "工资表 2026年度机密.xlsx - Excel"),
      ],
      EVENT_GAP_SECS,
    );
    const text = briefToText("2026-09-04", segs, [["text", 2]]);
    expect(text).not.toContain("机密");
    expect(text).not.toContain("xlsx");
    expect(text).toContain("Excel");
  });
});

describe("briefToText · 内容", () => {
  it("带上日期、总数、段数与每段的起止", () => {
    const segs = segmentByGap(
      [row("09:00:00", "Edge"), row("09:05:00", "Edge"), row("14:00:00", "企业微信")],
      EVENT_GAP_SECS,
    );
    const text = briefToText("2026-09-04", segs, [["text", 3]]);
    expect(text).toContain("9 月 4 日");
    expect(text).toContain("2 段");
    expect(text).toContain("09:00-09:05");
    expect(text).toContain("企业微信");
  });

  it("单条段只写一个时间点，不写 09:00-09:00", () => {
    const segs = segmentByGap([row("12:39:00", "Edge")], EVENT_GAP_SECS);
    const text = briefToText("2026-09-04", segs, [["text", 1]]);
    expect(text).toContain("12:39 ");
    expect(text).not.toContain("12:39-12:39");
  });

  it("空段列表不崩", () => {
    expect(() => briefToText("2026-09-04", [], [])).not.toThrow();
  });
});

describe("dayTitle", () => {
  it("带星期", () => {
    // 2026-09-04 是周五
    expect(dayTitle("2026-09-04")).toBe("9 月 4 日 · 周五");
  });

  it("不补零（中文习惯不写 09 月 04 日）", () => {
    expect(dayTitle("2026-01-05")).toContain("1 月 5 日");
  });
});
