import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { HistoryTimeSummary } from "./HistoryTimeSummary";
import { historyTimeWindow } from "@/lib/utils";

afterEach(cleanup);

it.each([
  [historyTimeWindow("2026-12-31", 18, 24), "2026-12-31 · 18:00–24:00"],
  [historyTimeWindow("2026-12-31"), "2026-12-31 · 全天"],
  [historyTimeWindow("2026-12-28", 0, 7 * 24), "2026-12-28 至 2027-01-03"],
  ["all", "不限日期与时段"],
])("摘要准确表达 %s 的日期及截止边界", (value, caption) => {
  render(<HistoryTimeSummary value={value} count={1205} loading={false} error="" />);
  expect(screen.getByRole("region", { name: "当前时间范围" })).toHaveTextContent(caption);
  expect(screen.getByText((1205).toLocaleString())).toBeInTheDocument();
});

it("未读取数量不冒充零条记录", () => {
  render(<HistoryTimeSummary value="all" count={null} loading={false} error="" />);
  expect(screen.getByRole("region", { name: "当前时间范围" })).toHaveTextContent("等待统计—条");
});
