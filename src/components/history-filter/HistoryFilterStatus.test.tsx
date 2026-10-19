import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSearchKey, useAppStore, type HistoryItem } from "@/stores/appStore";
import { HistoryFilterStatus } from "./HistoryFilterStatus";
import { HistoryQueryPending } from "./HistoryQueryPending";
const { mode } = vi.hoisted(() => ({ mode: { value: "full" } }));
vi.mock("@/components/MotionPolicy", () => ({ useInterfaceMotion: () => mode.value }));
const initial = useAppStore.getState();
beforeEach(() => {
  vi.useFakeTimers(); mode.value = "full";
  useAppStore.setState({ searchKeyword: "", timeFilter: "all", sourceFilter: "", filterType: "all", groupFilter: "all", selectedTagIds: [], history: [], searchResults: null, searchResultsKey: "", searchLoading: false, searchError: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); useAppStore.setState(initial); });
it("新分类不使用旧查询的数量或失败状态，当前请求失败可以原地重试", () => {
  useAppStore.setState({ sourceFilter: "微信", filterType: "image", searchResults: [], searchResultsKey: "old-query", searchError: true });
  render(<HistoryFilterStatus />); expect(screen.getByRole("status").textContent).toBe("图片· 正在切换");
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  act(() => useAppStore.setState({ searchResultsKey: buildSearchKey(useAppStore.getState()) }));
  expect(screen.getByRole("status").textContent).toContain("读取失败");
  const tick = useAppStore.getState().searchRetryTick; fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(useAppStore.getState().searchRetryTick).toBe(tick + 1);
});
it("显示实际已载入的结果数，不把分页条数宣称为总数", () => {
  useAppStore.setState({ history: [{ id: "a", type: "text", text: "示例", workspace: initial.config.current_workspace } as HistoryItem] });
  render(<HistoryFilterStatus />); expect(screen.getByRole("status").textContent).toBe("全部· 已显示 1 条");
});
it("加载提示延迟一秒，切换查询重新计时，卸载清理计时器", () => {
  const { rerender, unmount } = render(<HistoryQueryPending queryKey="a" />);
  act(() => vi.advanceTimersByTime(999)); expect(screen.queryByText("正在筛选记录…")).toBeNull();
  rerender(<HistoryQueryPending queryKey="b" />);
  act(() => vi.advanceTimersByTime(1)); expect(screen.queryByText("正在筛选记录…")).toBeNull();
  act(() => vi.advanceTimersByTime(999)); expect(screen.getByText("正在筛选记录…")).toBeTruthy();
  unmount(); expect(vi.getTimerCount()).toBe(0);
});
it("隐藏窗口不启动读取提示计时器", () => {
  mode.value = "hidden"; render(<HistoryQueryPending queryKey="hidden" />);
  expect(vi.getTimerCount()).toBe(0);
});
