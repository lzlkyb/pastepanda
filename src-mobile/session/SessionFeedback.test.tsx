import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionFeedback } from "./SessionFeedback";
import type { useSessionClipboard } from "./useSessionClipboard";
afterEach(() => { cleanup(); vi.useRealTimers(); });
const clipboard = { feedback: null, clipOpen: false } as unknown as ReturnType<typeof useSessionClipboard>;

it("重要错误保留，成功消息等待可见后才开始计时", () => {
  vi.useFakeTimers();
  const clearError = vi.fn(), clearSuccess = vi.fn();
  const pointer = { hint: "已切换为直接点击", hintTone: "success" as const, clearHint: clearSuccess };
  const view = render(<SessionFeedback pointer={pointer} orient={{ hint: "请检查自动旋转设置", clearHint: clearError }} clipboard={clipboard} onSendFailDismiss={() => {}} />);
  expect(screen.getByRole("alert").textContent).toContain("未能锁定横屏");
  act(() => vi.advanceTimersByTime(30000));
  expect(clearError).not.toHaveBeenCalled(); expect(clearSuccess).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(clearError).toHaveBeenCalledTimes(1);
  view.rerender(<SessionFeedback pointer={pointer} orient={{ hint: "", clearHint: clearError }} clipboard={clipboard} onSendFailDismiss={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain("已切换为直接点击");
  act(() => vi.advanceTimersByTime(4000));
  expect(clearSuccess).toHaveBeenCalledTimes(1);
});
it("剪贴板面板打开时不重复显示面板的错误，关闭后提供返回入口", () => {
  const open = vi.fn(), dismiss = vi.fn();
  const clip = { ...clipboard, feedback: { tone: "error" as const, title: "剪贴板未能取到手机" }, clipOpen: true, openClip: open, dismiss };
  const props = { pointer: { hint: "", hintTone: "success" as const, clearHint: vi.fn() }, orient: { hint: "", clearHint: vi.fn() }, onSendFailDismiss: vi.fn() };
  const view = render(<SessionFeedback {...props} clipboard={clip} />);
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<SessionFeedback {...props} clipboard={{ ...clip, clipOpen: false }} />);
  fireEvent.click(screen.getByRole("button", { name: "打开剪贴板" }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
});
