import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistorySourceFilter } from "./HistorySourceFilter";
import { HistoryTimeSelection } from "@/components/history-time/HistoryTimeSelection";
import { useHistorySourceDistribution } from "@/hooks/useHistorySourceDistribution";
import { useAppStore } from "@/stores/appStore";
import { historyTimeWindow } from "@/lib/utils";
import { setMotionPreference } from "@/lib/motionPreference";
import type { HistorySourceDistribution } from "@/lib/api/historySource";
vi.mock("@/hooks/useHistorySourceDistribution", () => ({ useHistorySourceDistribution: vi.fn() }));
vi.mock("@/hooks/useSourceIcon", () => ({ useSourceIcon: (source: string) => ({ displayName: source, emoji: "", realIconUrl: undefined }) }));
const selectedTime = historyTimeWindow("2026-10-18", 12, 18);
const data: HistorySourceDistribution = {
  total: { count: 8, text_count: 4, image_count: 3, file_count: 1, other_count: 0, latest_time: "2026-10-18 17:30:00" },
  sources: [
    { source: "微信", source_icon: "wechat.png", count: 5, text_count: 3, image_count: 2, file_count: 0, other_count: 0, latest_time: "2026-10-18 17:30:00" },
    { source: "Chrome", source_icon: null, count: 3, text_count: 1, image_count: 1, file_count: 1, other_count: 0, latest_time: "2026-10-18 16:00:00" },
  ],
};
beforeEach(() => {
  setMotionPreference(false);
  // JSDOM has no layout; supply the real scroll viewport to the real virtualizer.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("aria-label") === "来源记录数量" ? 252 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("aria-label") === "来源记录数量" ? 372 : 0; });
  useAppStore.setState({ timeFilter: selectedTime, sourceFilter: "", filterType: "all", searchKeyword: "方案", groupFilter: "review", selectedTagIds: ["tag"] });
  vi.mocked(useHistorySourceDistribution).mockReturnValue({ data, loading: false, error: "", refresh: vi.fn() });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); setMotionPreference(true); });
async function open(name = "全部来源") {
  render(<HistorySourceFilter />); fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog", { name: "按来源找回" });
}
it("悬停切换详情但不筛选，移开恢复；单击才筛选并收起", async () => {
  await open(); const chrome = screen.getByRole("button", { name: "Chrome，3 条记录" });
  fireEvent.pointerEnter(chrome);
  const details = screen.getByRole("region", { name: "来源内容详情" });
  expect(details).toHaveTextContent("预览 ·Chrome"); expect(details).toHaveTextContent("3 条");
  expect(details).toHaveTextContent("2026-10-18 16:00");
  expect(useAppStore.getState().sourceFilter).toBe("");
  expect(screen.getByRole("heading", { name: "全部来源" })).toBeVisible();
  fireEvent.pointerLeave(screen.getByLabelText("来源记录数量")); expect(details).toHaveTextContent("全部来源");
  fireEvent.click(chrome); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(useAppStore.getState()).toMatchObject({ sourceFilter: "Chrome", timeFilter: selectedTime, searchKeyword: "方案", groupFilter: "review", selectedTagIds: ["tag"] });
});
it("已选来源仍显示其他应用，键盘可预览，离开和重新打开恢复已选详情", async () => {
  useAppStore.setState({ sourceFilter: "微信" }); await open("微信");
  const chrome = screen.getByRole("button", { name: "Chrome，3 条记录" });
  expect(screen.getByRole("button", { name: "微信，5 条记录" })).toHaveAttribute("aria-pressed", "true");
  act(() => chrome.focus()); expect(screen.getByRole("region")).toHaveTextContent("预览 ·Chrome");
  act(() => screen.getByRole("button", { name: "清除来源" }).focus());
  expect(screen.getByRole("region")).not.toHaveTextContent("预览 ·");
  expect(screen.getByRole("region")).toHaveTextContent("微信");
  fireEvent.pointerEnter(chrome); fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "微信" }));
  expect(await screen.findByRole("region")).not.toHaveTextContent("预览 ·");
});
it("来源搜索只过滤选项；无匹配可清除，主列表关键词不变", async () => {
  await open(); fireEvent.change(screen.getByRole("textbox", { name: "搜索来源应用" }), { target: { value: "Chrome" } });
  expect(screen.queryByRole("button", { name: "微信，5 条记录" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Chrome，3 条记录" })).toBeVisible();
  expect(useAppStore.getState().searchKeyword).toBe("方案");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "notfound" } });
  expect(screen.getByText("没有匹配的来源应用")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "清除应用名称搜索" }));
  expect(screen.getByRole("button", { name: "微信，5 条记录" })).toBeVisible();
});
it("清除来源保留其他条件，包括当前范围无该来源的情况", async () => {
  useAppStore.setState({ sourceFilter: "Missing" }); await open("Missing");
  expect(screen.getByText("该来源在当前范围没有匹配记录，可切换来源或清除来源。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "清除来源" }));
  expect(useAppStore.getState()).toMatchObject({ sourceFilter: "", timeFilter: selectedTime, searchKeyword: "方案", groupFilter: "review" });
});
it("加载、错误与空范围的反馈不冒充真实数量，并能重试和扩大时间", async () => {
  const refresh = vi.fn();
  vi.mocked(useHistorySourceDistribution).mockReturnValue({ data: null, loading: true, error: "", refresh });
  const dialog = await open(); expect(within(dialog).getByText("—")).toBeVisible();
  expect(screen.getByText("正在读取来源分布…")).toBeVisible();
  vi.mocked(useHistorySourceDistribution).mockReturnValue({ data: null, loading: false, error: "读取失败，记录列表已保留", refresh });
  // Store updates rerender the surface with the new hook result.
  act(() => useAppStore.setState({ searchKeyword: "新条件" }));
  expect(screen.getByText("来源分布读取失败")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" })); expect(refresh).toHaveBeenCalled();
  vi.mocked(useHistorySourceDistribution).mockReturnValue({ data: { total: { ...data.total, count: 0 }, sources: [] }, loading: false, error: "", refresh });
  act(() => useAppStore.setState({ searchKeyword: "空条件" }));
  expect(screen.getByText("当前范围没有记录")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看全部时间" })); expect(useAppStore.getState().timeFilter).toBe("all");
});
it("面板键盘操作不穿透主列表，触屏移入不产生预览", async () => {
  await open(); const onKey = vi.fn(); document.addEventListener("keydown", onKey);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Delete" }); expect(onKey).not.toHaveBeenCalled(); document.removeEventListener("keydown", onKey);
  const target = screen.getByRole("button", { name: "Chrome，3 条记录" });
  const touch = new Event("pointerover", { bubbles: true }); Object.defineProperty(touch, "pointerType", { value: "touch" });
  fireEvent(target, touch);
  expect(screen.getByRole("region")).not.toHaveTextContent("预览 ·");
});
it("来源芯片在没有时间筛选时也可见，清除只影响来源", () => {
  useAppStore.setState({ timeFilter: "all", sourceFilter: "微信" }); render(<HistoryTimeSelection />);
  fireEvent.click(screen.getByRole("button", { name: "清除来源条件" }));
  expect(useAppStore.getState()).toMatchObject({ sourceFilter: "", timeFilter: "all", searchKeyword: "方案" });
});
it("大量来源只挂载可见行，名称搜索仍能找到未挂载的来源", async () => {
  const sources = Array.from({ length: 1000 }, (_, i) => ({ ...data.sources[0], source: `Archive${i}`, count: 1 }));
  vi.mocked(useHistorySourceDistribution).mockReturnValue({ data: { total: { ...data.total, count: 1000 }, sources }, loading: false, error: "", refresh: vi.fn() });
  await open();
  expect(screen.getAllByRole("button", { name: /，1 条记录$/ }).length).toBeLessThanOrEqual(20);
  expect(screen.queryByRole("button", { name: "Archive999，1 条记录" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索来源应用" }), { target: { value: "Archive999" } });
  expect(screen.getByRole("button", { name: "Archive999，1 条记录" })).toBeVisible();
});
