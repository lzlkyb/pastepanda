import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryTimeFilter } from "./HistoryTimeFilter";
import { HistoryTimeSelection } from "./HistoryTimeSelection";
import { useHistoryTimeDistribution } from "@/hooks/useHistoryTimeDistribution";
import { useAppStore } from "@/stores/appStore";
import { historyTimeWindow, historyLocalDate, historyDateOffset, historyTimeLabel } from "@/lib/utils";
import { setMotionPreference } from "@/lib/motionPreference";
vi.mock("@/hooks/useHistoryTimeDistribution", () => ({ useHistoryTimeDistribution: vi.fn() }));
const today = historyLocalDate(new Date());
const data = { days: [{ date: today, count: 8 }], selected_date: today, hours: Array.from({ length: 24 }, (_, h) => h === 13 ? 8 : 0), sources: [{ source: "微信", count: 8 }], selection_count: 8 };
beforeEach(() => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  setMotionPreference(true);
  useAppStore.setState({ timeFilter: "all", filterType: "image", searchKeyword: "方案", sourceFilter: "微信", searchLoading: false, searchError: false });
  vi.mocked(useHistoryTimeDistribution).mockReturnValue({ data, selectionCount: 8, loading: false, error: "", refresh: vi.fn() });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); delete document.documentElement.dataset.interfaceMotion; setMotionPreference(true); });

it("面板通过 portal 展开，日期及时段按真实区间筛选，收起保留条件", async () => {
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: "时间" }));
  expect(await screen.findByRole("dialog", { name: "按时间找回" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: `${today}，8 条记录` }));
  expect(useAppStore.getState().timeFilter).toBe(historyTimeWindow(today));
  fireEvent.click(screen.getByRole("button", { name: "下午，8 条记录" }));
  expect(useAppStore.getState().timeFilter).toBe(historyTimeWindow(today, 12, 18));
  fireEvent.click(screen.getByRole("button", { name: "查看 8 条记录" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(useAppStore.getState().timeFilter).toBe(historyTimeWindow(today, 12, 18));
});
it("没有记录也保留日期和时段选项；失败提供同层重试入口", async () => {
  const refresh = vi.fn();
  vi.mocked(useHistoryTimeDistribution).mockReturnValue({ data: null, selectionCount: null, loading: false, error: "时间分布读取失败", refresh });
  render(<HistoryTimeFilter />); fireEvent.click(screen.getByRole("button", { name: "时间" }));
  expect(await screen.findByText("分布未读取成功，不代表记录为空。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" })); expect(refresh).toHaveBeenCalled();
});
it("清除时间只清除时间，保留关键词、类型与来源", () => {
  useAppStore.setState({ timeFilter: historyTimeWindow(today) });
  render(<HistoryTimeSelection />);
  fireEvent.click(screen.getByRole("button", { name: "清除时间条件" }));
  expect(useAppStore.getState()).toMatchObject({ timeFilter: "all", searchKeyword: "方案", filterType: "image", sourceFilter: "微信" });
});
it("Esc 收起时间面板，不清空所选日期", async () => {
  render(<HistoryTimeFilter />); fireEvent.click(screen.getByRole("button", { name: "时间" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
it("面板打开时 Delete 和 Enter 不穿透到主列表快捷键", async () => {
  render(<HistoryTimeFilter />);
  const trigger = screen.getByRole("button", { name: "时间" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  const behind = vi.fn();
  window.addEventListener("keydown", behind);
  try {
    fireEvent.keyDown(trigger, { key: "Delete" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(behind).not.toHaveBeenCalled();
  } finally { window.removeEventListener("keydown", behind); }
});

it.each(["收起时间面板", "查看 8 条记录", "Escape", "时间", "外部点击"])("%s 关闭时保留面板播放退场，立即停止统计", async action => {
  render(<HistoryTimeFilter />);
  const trigger = screen.getByRole("button", { name: "时间" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog.firstElementChild).toHaveAttribute("data-state", "open"));
  if (action === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
  else if (action === "外部点击") fireEvent.pointerDown(document.body);
  else fireEvent.click(screen.getByRole("button", { name: action }));
  expect(dialog).toBeInTheDocument();
  expect(dialog).toHaveAttribute("inert");
  expect(dialog.firstElementChild).toHaveAttribute("data-state", "close");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(vi.mocked(useHistoryTimeDistribution).mock.lastCall?.[0]).toBe(false);
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
});

it("范围摘要与查看按钮显示同一统计数量，时段选择仍直接生效", async () => {
  useAppStore.setState({ timeFilter: historyTimeWindow(today, 12, 18) });
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: "今天 · 下午" }));
  const summary = await screen.findByRole("region", { name: "当前时间范围" });
  expect(summary).toHaveTextContent("今天 · 下午");
  expect(summary).toHaveTextContent("12:00–18:00");
  expect(summary).toHaveTextContent("找到记录8条");
  expect(screen.getByRole("button", { name: "查看 8 条记录" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "下午，8 条记录" })).toHaveAttribute("aria-pressed", "true");
});

it.each(["loading", "error"])("%s 时摘要不把旧数量或未读取数量显示成零", async state => {
  vi.mocked(useHistoryTimeDistribution).mockReturnValue({ data, selectionCount: 8, loading: state === "loading", error: state === "error" ? "读取失败" : "", refresh: vi.fn() });
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: "时间" }));
  const summary = await screen.findByRole("region", { name: "当前时间范围" });
  expect(summary).toHaveTextContent(state === "loading" ? "正在统计—" : "数量未读取—");
  expect(summary).not.toHaveTextContent("8条");
  expect(screen.getByRole("button", { name: "查看记录" })).toBeEnabled();
});

it("无结果时先扩大到全天，再清除时间，保留其他筛选且面板不关闭", async () => {
  useAppStore.setState({ timeFilter: historyTimeWindow(today, 12, 18) });
  vi.mocked(useHistoryTimeDistribution).mockReturnValue({ data, selectionCount: 0, loading: false, error: "", refresh: vi.fn() });
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: "今天 · 下午" }));
  expect(await screen.findByRole("region", { name: "当前时间范围" })).toHaveTextContent("暂无匹配0条");
  fireEvent.click(screen.getByRole("button", { name: "查看全天" }));
  expect(useAppStore.getState().timeFilter).toBe(historyTimeWindow(today));
  fireEvent.click(screen.getByRole("button", { name: "查看全部时间" }));
  expect(useAppStore.getState()).toMatchObject({ timeFilter: "all", searchKeyword: "方案", filterType: "image", sourceFilter: "微信" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("选择更早日期后，最近 14 天图表不插入范围外的第十五根柱", async () => {
  const old = historyDateOffset(today, -30);
  useAppStore.setState({ timeFilter: historyTimeWindow(old) });
  vi.mocked(useHistoryTimeDistribution).mockReturnValue({ data: { ...data, selected_date: old, days: [{ date: old, count: 8 }, ...data.days] }, selectionCount: 8, loading: false, error: "", refresh: vi.fn() });
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: historyTimeLabel(historyTimeWindow(old)) }));
  await screen.findByRole("dialog");
  expect(screen.queryByRole("button", { name: `${old}，8 条记录` })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: `${today}，8 条记录` })).toBeInTheDocument();
  expect(screen.getByLabelText("其他日期")).toHaveValue(old);
});

it("全部时间仍无结果时给出调整搜索的提示，不重复提供无效的扩大范围动作", async () => {
  vi.mocked(useHistoryTimeDistribution).mockReturnValue({ data, selectionCount: 0, loading: false, error: "", refresh: vi.fn() });
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: "时间" }));
  expect(await screen.findByText("没有匹配记录，可调整搜索或类型")).toBeVisible();
  expect(screen.queryByRole("button", { name: "查看全部时间" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看记录" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("退场期间再次打开会取消卸载并恢复交互", async () => {
  render(<HistoryTimeFilter />);
  const trigger = screen.getByRole("button", { name: "时间" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "收起时间面板" }));
  expect(dialog).toBeInTheDocument();
  fireEvent.click(trigger);
  await waitFor(() => expect(dialog.firstElementChild).toHaveAttribute("data-state", "open"));
  expect(dialog).not.toHaveAttribute("inert");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
});

it.each(["off", "reduced", "system", "app", "hidden"])("动效偏好 %s 时不播放空间动画或延迟退场", async preference => {
  if (preference === "system") vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  else if (preference === "app") setMotionPreference(false);
  else if (preference === "hidden") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  else document.documentElement.dataset.interfaceMotion = preference;
  render(<HistoryTimeFilter />);
  fireEvent.click(screen.getByRole("button", { name: "时间" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.firstElementChild).toHaveAttribute("data-motion", "off");
  fireEvent.click(screen.getByRole("button", { name: "收起时间面板" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument(), { timeout: 100 });
});
