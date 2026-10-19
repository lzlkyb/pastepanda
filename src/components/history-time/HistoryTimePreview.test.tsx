import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryTimeFilter } from "./HistoryTimeFilter";
import { useHistoryTimeDistribution } from "@/hooks/useHistoryTimeDistribution";
import { useAppStore } from "@/stores/appStore";
import { historyDateOffset, historyLocalDate, historyTimeWindow, parseHistoryWindow } from "@/lib/utils";

vi.mock("@/hooks/useHistoryTimeDistribution", () => ({ useHistoryTimeDistribution: vi.fn() }));
const today = historyLocalDate(new Date()), yesterday = historyDateOffset(today, -1), older = historyDateOffset(today, -2);
const counts: Record<string, number> = { [today]: 8, [yesterday]: 3, [older]: 5 };
function distribution(date: string) {
  return { data: { days: Object.entries(counts).map(([date, count]) => ({ date, count })), selected_date: date,
    hours: Array.from({ length: 24 }, (_, h) => h === 13 ? counts[date] : 0), sources: [{ source: date === today ? "微信" : "浏览器", count: counts[date] }], selection_count: 8 },
    selectionCount: counts[parseHistoryWindow(useAppStore.getState().timeFilter)?.start.slice(0, 10) ?? today], loading: false, error: "", refresh: vi.fn() };
}
beforeEach(() => {
  useAppStore.setState({ timeFilter: historyTimeWindow(today, 12, 18), filterType: "all", searchKeyword: "", sourceFilter: "" });
  vi.mocked(useHistoryTimeDistribution).mockImplementation((_open, date) => distribution(date));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
async function open() {
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: "今天 · 下午" }));
  await screen.findByRole("dialog");
}

it("悬停切换下方日期、时段和来源，主列表条件及顶部数量保持已选范围；离开恢复", async () => {
  await open();
  fireEvent.pointerEnter(screen.getByRole("button", { name: `${yesterday}，3 条记录` }));
  const detail = await screen.findByRole("region", { name: "日期时段详情" });
  expect(detail).toHaveTextContent("预览 · 昨天");
  expect(within(detail).getByRole("button", { name: "下午，3 条记录" })).toBeInTheDocument();
  expect(detail).toHaveTextContent("主要来源：浏览器");
  expect(screen.getByRole("region", { name: "当前时间范围" })).toHaveTextContent("今天 · 下午");
  expect(screen.getByRole("button", { name: "查看 8 条记录" })).toBeInTheDocument();
  expect(useAppStore.getState().timeFilter).toBe(historyTimeWindow(today, 12, 18));
  expect(screen.getByRole("button", { name: `${yesterday}，3 条记录` })).toHaveAttribute("aria-pressed", "false");
  fireEvent.pointerLeave(screen.getByLabelText("按日期统计的记录数量"));
  expect(detail).not.toHaveTextContent("预览 ·");
  expect(within(detail).getByRole("button", { name: "下午，8 条记录" })).toBeInTheDocument();
});

it("连续移过日期显示最后一根柱的数据，点击才采纳该日期", async () => {
  await open();
  fireEvent.pointerEnter(screen.getByRole("button", { name: `${yesterday}，3 条记录` }));
  const target = screen.getByRole("button", { name: `${older}，5 条记录` });
  fireEvent.pointerEnter(target);
  const detail = await screen.findByRole("region", { name: "日期时段详情" });
  expect(within(detail).getByRole("button", { name: "下午，5 条记录" })).toBeInTheDocument();
  fireEvent.click(target);
  expect(useAppStore.getState().timeFilter).toBe(historyTimeWindow(older));
  expect(detail).not.toHaveTextContent("预览 ·");
  expect(target).toHaveAttribute("aria-pressed", "true");
});

it("键盘聚焦也能预览，移出日期图恢复，关闭再打开不残留预览", async () => {
  await open();
  const target = screen.getByRole("button", { name: `${yesterday}，3 条记录` });
  fireEvent.focus(target);
  expect(await screen.findByRole("region", { name: "日期时段详情" })).toHaveTextContent("预览 · 昨天");
  fireEvent.blur(target, { relatedTarget: screen.getByRole("button", { name: "查看 8 条记录" }) });
  expect(screen.getByRole("region", { name: "日期时段详情" })).not.toHaveTextContent("预览 ·");
  fireEvent.pointerEnter(target);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "今天 · 下午" }));
  expect(await screen.findByRole("region", { name: "日期时段详情" })).not.toHaveTextContent("预览 ·");
});

it.each(["loading", "error"])("预览 %s 时不把其他日期的时段冒充当前柱的数据", async state => {
  vi.mocked(useHistoryTimeDistribution).mockImplementation((_open, date) => date === yesterday
    ? { ...distribution(today), loading: state === "loading", error: state === "error" ? "读取失败" : "" } : distribution(date));
  await open();
  fireEvent.pointerEnter(screen.getByRole("button", { name: `${yesterday}，3 条记录` }));
  const detail = await screen.findByRole("region", { name: "日期时段详情" });
  expect(detail).toHaveTextContent(state === "loading" ? "正在读取预览时段" : "预览读取失败");
  expect(within(detail).queryByRole("button", { name: "下午，8 条记录" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看 8 条记录" })).toBeEnabled();
});
