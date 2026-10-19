import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import { searchHistory } from "@/lib/api/history";
import { historyTimeWindow } from "@/lib/utils";
import { useHistorySearch } from "./useHistorySearch";
vi.mock("@/lib/api/history", () => ({ searchHistory: vi.fn() }));
vi.mock("./useWindowVisible", () => ({ useWindowVisible: () => true }));
beforeEach(() => { useAppStore.setState({ searchKeyword: "", timeFilter: "all", filterType: "all", sourceFilter: "", groupFilter: "all", selectedTagIds: [], searchResults: null, searchResultsKey: "", searchLoading: false, searchError: false }); vi.mocked(searchHistory).mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("只选日期也查数据库，关键词、类型、来源完整下推", async () => {
  useAppStore.setState({ timeFilter: historyTimeWindow("2026-10-17"), filterType: "image", sourceFilter: "微信" });
  renderHook(useHistorySearch);
  await waitFor(() => expect(searchHistory).toHaveBeenCalledWith(expect.objectContaining({ search: "", timeFilter: historyTimeWindow("2026-10-17"), filter: "image", source: "微信" })));
});
it("记录视图未显示时不发起查询，恢复后读取最新筛选", async () => {
  useAppStore.setState({ timeFilter: historyTimeWindow("2026-10-17") });
  const { rerender } = renderHook(({ enabled }) => useHistorySearch(enabled), { initialProps: { enabled: false } });
  expect(searchHistory).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(searchHistory).toHaveBeenCalledTimes(1));
});
it("清除时间后，延迟响应不能重新填回旧日期", async () => {
  let finish!: (items: HistoryItem[]) => void;
  vi.mocked(searchHistory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  useAppStore.setState({ timeFilter: historyTimeWindow("2026-10-17") });
  renderHook(useHistorySearch);
  act(() => useAppStore.getState().setTimeFilter("all"));
  await act(async () => finish([{ id: "old" } as HistoryItem]));
  expect(useAppStore.getState().searchResults).toBeNull();
  expect(useAppStore.getState().searchLoading).toBe(false);
});
it("快速换日期只接受最后一个响应", async () => {
  let finish!: (items: HistoryItem[]) => void;
  vi.mocked(searchHistory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  useAppStore.setState({ timeFilter: historyTimeWindow("2026-10-17") });
  renderHook(useHistorySearch);
  act(() => useAppStore.getState().setTimeFilter(historyTimeWindow("2026-10-16")));
  await waitFor(() => expect(useAppStore.getState().searchLoading).toBe(false));
  await act(async () => finish([{ id: "old" } as HistoryItem]));
  expect(useAppStore.getState().searchResults).toEqual([]);
});
it("查询失败显示错误并可重试，不把失败当成空结果", async () => {
  vi.mocked(searchHistory).mockRejectedValueOnce(new Error("busy"));
  useAppStore.setState({ timeFilter: historyTimeWindow("2026-10-17") });
  renderHook(useHistorySearch);
  await waitFor(() => expect(useAppStore.getState().searchError).toBe(true));
  act(() => useAppStore.getState().retrySearch());
  await waitFor(() => expect(useAppStore.getState().searchError).toBe(false));
  expect(searchHistory).toHaveBeenCalledTimes(2);
});
it("仅选来源也从数据库找回未加载的旧记录，列表使用同一份结果", async () => {
  const old = { id: "not-loaded", source: "OldApp", type: "text", workspace: useAppStore.getState().config.current_workspace } as HistoryItem;
  vi.mocked(searchHistory).mockResolvedValueOnce([old]);
  useAppStore.setState({ history: [], sourceFilter: "OldApp", searchKeyword: "", timeFilter: "all" });
  renderHook(useHistorySearch);
  await waitFor(() => expect(searchHistory).toHaveBeenCalledWith(expect.objectContaining({ source: "OldApp", search: "", timeFilter: "all" })));
  await waitFor(() => expect(useAppStore.getState().getFilteredItems()).toEqual([old]));
});
it("仅选来源时快速切换和清除，不接受上一来源的迟到结果", async () => {
  let finish!: (items: HistoryItem[]) => void;
  vi.mocked(searchHistory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  useAppStore.setState({ sourceFilter: "OldApp", timeFilter: "all", searchKeyword: "" });
  renderHook(useHistorySearch);
  await waitFor(() => expect(searchHistory).toHaveBeenCalledTimes(1));
  act(() => useAppStore.getState().setSourceFilter("OtherApp"));
  await waitFor(() => expect(searchHistory).toHaveBeenCalledTimes(2));
  act(() => useAppStore.getState().setSourceFilter(""));
  await act(async () => finish([{ id: "stale" } as HistoryItem]));
  expect(useAppStore.getState().searchResults).toBeNull();
});

it("分类连续切换只接受最后一类的响应，进行中的查询保留自己的签名", async () => {
  let finish!: (items: HistoryItem[]) => void;
  vi.mocked(searchHistory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  useAppStore.setState({ sourceFilter: "微信", filterType: "text" });
  renderHook(useHistorySearch);
  const firstKey = useAppStore.getState().searchResultsKey;
  expect(firstKey).toContain("|text|");
  act(() => useAppStore.getState().setFilterType("image"));
  await waitFor(() => expect(useAppStore.getState().searchLoading).toBe(false));
  const latestKey = useAppStore.getState().searchResultsKey;
  await act(async () => finish([{ id: "old-text" } as HistoryItem]));
  expect(useAppStore.getState().searchResultsKey).toBe(latestKey);
  expect(useAppStore.getState().searchResults).toEqual([]);
});

it("隐藏取消的在途查询恢复后重新发起，不把有签名的占位空数组当缓存", async () => {
  vi.mocked(searchHistory).mockImplementationOnce(() => new Promise(() => {}));
  useAppStore.setState({ sourceFilter: "微信" });
  const { rerender } = renderHook(({ enabled }) => useHistorySearch(enabled), { initialProps: { enabled: true } });
  rerender({ enabled: false }); rerender({ enabled: true });
  await waitFor(() => expect(searchHistory).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(useAppStore.getState().searchLoading).toBe(false));
});
