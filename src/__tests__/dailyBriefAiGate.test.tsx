import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyBriefDialog } from "@/components/DailyBriefDialog";

const mocks = vi.hoisted(() => ({ status: "off", available: false, run: vi.fn(), toast: vi.fn() }));
vi.mock("@/hooks/useAiStatus", () => ({ useAiStatus: () => ({ status: mocks.status }) }));
vi.mock("@/lib/transforms/aiTransforms", () => ({ isAiAvailable: () => mocks.available }));
vi.mock("@/lib/api/ai", () => ({ aiRun: mocks.run }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/dialogMotion", () => ({ useDialogAnim: () => ({ backdrop: {}, panel: {} }) }));
vi.mock("@/lib/api/dailyBrief", async (original) => ({
  ...await original<typeof import("@/lib/api/dailyBrief")>(),
  historyDayMeta: vi.fn().mockResolvedValue([
    { id: "audit-1", time: "2026-10-10 08:00:00", source: "audit", type: "text", content_type: null },
    { id: "audit-2", time: "2026-10-10 10:00:00", source: "audit", type: "text", content_type: null },
  ]),
}));

beforeEach(() => { mocks.status = "off"; mocks.available = false; mocks.run.mockReset(); mocks.toast.mockReset(); });
afterEach(cleanup);

it.each(["off", "loading", "nokey"])("keeps local timeline but hides AI when status is %s", async (status) => {
  mocks.status = status;
  render(<DailyBriefDialog onClose={() => {}} />);
  await screen.findByText("这一天的时间线");
  expect(screen.queryByRole("button", { name: "生成今日小结" })).toBeNull();
  expect(mocks.run).not.toHaveBeenCalled();
});

it("removes the AI action when availability changes while the dialog stays open", async () => {
  mocks.status = "on"; mocks.available = true;
  const view = render(<DailyBriefDialog onClose={() => {}} />);
  await screen.findByRole("button", { name: "生成今日小结" });
  mocks.status = "off"; mocks.available = false;
  view.rerender(<DailyBriefDialog onClose={() => {}} />);
  expect(screen.queryByRole("button", { name: "生成今日小结" })).toBeNull();
  expect(screen.getByText("这一天的时间线")).toBeTruthy();
  expect(mocks.run).not.toHaveBeenCalled();
});

it("rechecks availability before an already visible action can send a request", async () => {
  mocks.status = "on";
  render(<DailyBriefDialog onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "生成今日小结" }));
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith("请先在设置里配置 AI", "info");
});
