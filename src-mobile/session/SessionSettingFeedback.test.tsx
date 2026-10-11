import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionSettingFeedback } from "./SessionSettingFeedback";
import type { SessionSettingState } from "./useSessionSettings";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("电脑接受回执可关闭、可见计时后收起", () => {
  vi.useFakeTimers(); const dismiss = vi.fn();
  const state: SessionSettingState = { status: "accepted", value: "sharp", feedback: { tone: "success", title: "电脑已接受画质设置" } };
  render(<SessionSettingFeedback state={state} onRetry={vi.fn()} onDismiss={dismiss} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" })); expect(dismiss).toHaveBeenCalledOnce();
  dismiss.mockClear(); act(() => vi.advanceTimersByTime(4000)); expect(dismiss).toHaveBeenCalledOnce();
});
it.each(["error", "unconfirmed"] as const)("%s 保留真实结果和重试入口", status => {
  vi.useFakeTimers(); const retry = vi.fn(), dismiss = vi.fn();
  const state: SessionSettingState = { status, value: "sharp", feedback: { tone: status === "error" ? "error" : "warning", title: "未确认画质" } };
  render(<SessionSettingFeedback state={state} onRetry={retry} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(30000)); expect(dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: status === "error" ? "重试" : "重新发送" })); expect(retry).toHaveBeenCalledOnce();
});
