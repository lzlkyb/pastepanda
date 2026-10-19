import { describe, expect, it } from "vitest";
import { historyDateOffset, historyLocalDate, historyTimeLabel, historyTimeWindow, isHistoryQueryActive, parseHistoryWindow } from "@/lib/utils";
import { useAppStore, type HistoryItem } from "@/stores/appStore";

describe("按时间查找的日历与查询口径", () => {
  const now = new Date(2026, 9, 18, 12);
  it("用本地日历处理跨月、闰年与跨年", () => {
    expect(historyLocalDate(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(historyDateOffset("2026-01-01", -1)).toBe("2025-12-31");
    expect(historyDateOffset("2024-02-28", 1)).toBe("2024-02-29");
    expect(historyTimeWindow("2026-10-18")).toBe("window:2026-10-18 00:00:00~2026-10-19 00:00:00");
  });
  it("不丢失日期范围、时段与旧事件标签", () => {
    expect(historyTimeLabel(historyTimeWindow("2026-10-17"), now)).toBe("昨天");
    expect(historyTimeLabel(historyTimeWindow("2026-10-17", 12, 18), now)).toBe("昨天 · 下午");
    expect(historyTimeLabel(historyTimeWindow("2026-10-17", 22, 24), now)).toBe("昨天 · 22:00–24:00");
    expect(historyTimeLabel(historyTimeWindow("2026-10-12", 0, 168), now)).toBe("本周");
    expect(historyTimeLabel("range:2026-10-17 13:01:00~2026-10-17 13:05:00", now)).toContain("13:01–13:05");
  });
  it("时间筛选与关键词用同一个后端查询门控", () => {
    expect(isHistoryQueryActive("", "all", "")).toBe(false);
    for (const filter of ["today", "week", "month", historyTimeWindow("2026-10-17"), "range:a~b"]) expect(isHistoryQueryActive("", filter, "")).toBe(true);
    expect(isHistoryQueryActive("截图", "all", "")).toBe(true);
    expect(isHistoryQueryActive("", "all", "OldApp")).toBe(true);
    expect(parseHistoryWindow("window:bad")).toBeNull();
  });
  it("内存回退也使用右开区间，保留末秒的小数而排除次日", () => {
    const item = (id: string, time: string) => ({ id, time, workspace: "默认", type: "text", text: id, content: "", source: "", pinned: false }) as HistoryItem;
    const previous = useAppStore.getState();
    useAppStore.setState({ history: [item("late", "2026-10-17 23:59:59.999"), item("next", "2026-10-18 00:00:00")], searchResults: null,
      timeFilter: historyTimeWindow("2026-10-17"), searchKeyword: "", filterType: "all", sourceFilter: "", groupFilter: "all", selectedTagIds: [], _filterCache: null,
      config: { ...previous.config, current_workspace: "默认" } });
    expect(useAppStore.getState().getFilteredItems().map(i => i.id)).toEqual(["late"]);
    useAppStore.setState(previous);
  });
});
