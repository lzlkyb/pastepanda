import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/appStore";
import { getHistoryTimeDistribution, type HistoryTimeDistribution } from "@/lib/api/historyTime";
import { cancelStorageRequest } from "@/lib/api/storage";
import { useHistoryTimeDistribution } from "./useHistoryTimeDistribution";
vi.mock("./useWindowVisible", () => ({ useWindowVisible: () => true }));
vi.mock("@/lib/api/historyTime", () => ({ getHistoryTimeDistribution: vi.fn() }));
vi.mock("@/lib/api/storage", () => ({ cancelStorageRequest: vi.fn(async () => {}) }));
const data: HistoryTimeDistribution = { days: [{ date: "2026-10-17", count: 12 }], selected_date: "2026-10-17", hours: Array(24).fill(0), sources: [], selection_count: 12 };
beforeEach(() => { vi.useFakeTimers(); useAppStore.setState({ searchKeyword: "", timeFilter: "all", filterType: "all", sourceFilter: "", groupFilter: "all", selectedTagIds: [] }); vi.mocked(getHistoryTimeDistribution).mockResolvedValue(data); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
const flush = async () => act(async () => { await vi.advanceTimersByTimeAsync(160); });

it("关闭时不查询；打开才获取完整筛选条件下的分布", async () => {
  const { rerender, result } = renderHook(({ open }) => useHistoryTimeDistribution(open, "2026-10-17"), { initialProps: { open: false } });
  await flush(); expect(getHistoryTimeDistribution).not.toHaveBeenCalled();
  rerender({ open: true }); await flush();
  expect(getHistoryTimeDistribution).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ selected_date: "2026-10-17", source: "", group_filter: "all", tag_ids: [] }));
  expect(result.current.data).toEqual(data);
});
it("关闭取消后台任务，迟到数据不能写回", async () => {
  let finish!: (value: HistoryTimeDistribution) => void;
  vi.mocked(getHistoryTimeDistribution).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { rerender, result } = renderHook(({ open }) => useHistoryTimeDistribution(open, "2026-10-17"), { initialProps: { open: true } });
  await flush(); rerender({ open: false });
  expect(cancelStorageRequest).toHaveBeenCalled();
  await act(async () => finish(data)); expect(result.current.data).toBeNull();
});
it("切换时段保留日期图，但新数量未返回前不冒充旧数量", async () => {
  const { result } = renderHook(() => useHistoryTimeDistribution(true, "2026-10-17")); await flush();
  act(() => useAppStore.getState().setTimeFilter("today"));
  expect(result.current.data).toEqual(data); expect(result.current.selectionCount).toBeNull();
  await flush(); expect(result.current.selectionCount).toBe(12);
});
it("失败保留同条件的图表，可重试；不同条件不沿用旧图表", async () => {
  const { result } = renderHook(() => useHistoryTimeDistribution(true, "2026-10-17")); await flush();
  vi.mocked(getHistoryTimeDistribution).mockRejectedValueOnce(new Error("busy"));
  act(() => result.current.refresh()); await flush();
  expect(result.current.data).toEqual(data); expect(result.current.error).toContain("失败");
  act(() => result.current.refresh()); await flush(); expect(result.current.error).toBe("");
  act(() => useAppStore.getState().setFilterType("image")); expect(result.current.data).toBeNull();
});

it("快速预览合并查询，切换后取消旧日期且迟到响应不能覆盖最新日期", async () => {
  const pending = new Map<string, (value: HistoryTimeDistribution) => void>();
  vi.mocked(getHistoryTimeDistribution).mockImplementation((_id, query) => new Promise(resolve => { pending.set(query.selected_date, resolve); }));
  const { rerender, result } = renderHook(({ date, open }) => useHistoryTimeDistribution(open, date), { initialProps: { date: "2026-10-17", open: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  rerender({ date: "2026-10-16", open: true });
  await flush();
  expect(getHistoryTimeDistribution).toHaveBeenCalledTimes(1);
  const firstId = vi.mocked(getHistoryTimeDistribution).mock.calls[0][0];
  rerender({ date: "2026-10-15", open: true }); await flush();
  expect(cancelStorageRequest).toHaveBeenCalledWith(firstId);
  await act(async () => pending.get("2026-10-15")!({ ...data, selected_date: "2026-10-15" }));
  await act(async () => pending.get("2026-10-16")!({ ...data, selected_date: "2026-10-16" }));
  expect(result.current.data?.selected_date).toBe("2026-10-15");
  const lastId = vi.mocked(getHistoryTimeDistribution).mock.calls[1][0];
  rerender({ date: "2026-10-15", open: false });
  expect(cancelStorageRequest).toHaveBeenCalledWith(lastId);
});
