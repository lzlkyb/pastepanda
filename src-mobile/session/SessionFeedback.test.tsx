import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  expect(screen.getByRole("alert").textContent).toContain("显示方向未能切换");
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
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  fireEvent.click(screen.getByRole("button", { name: "打开剪贴板" }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
});

it("多个故障只显示一个摘要，详情保留全部处理入口", () => {
  const props = { pointer: { hint: "", hintTone: "success" as const, clearHint: vi.fn() }, orient: { hint: "方向切换失败", clearHint: vi.fn() }, onSendFailDismiss: vi.fn(), clipboard };
  render(<SessionFeedback {...props} sendFailed />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "2 条提示" }));
  expect(screen.getByRole("dialog", { name: "会话提示" }).textContent).toContain("方向切换失败");
});

it("最后一个故障消失时释放详情面板的远程输入锁", () => {
  const changed = vi.fn();
  const props = { pointer: { hint: "", hintTone: "success" as const, clearHint: vi.fn() }, orient: { hint: "", clearHint: vi.fn() }, onSendFailDismiss: vi.fn(), clipboard, onOpenChange: changed };
  const view = render(<SessionFeedback {...props} sendFailed />);
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  expect(changed).toHaveBeenLastCalledWith(true);
  view.rerender(<SessionFeedback {...props} sendFailed={false} />);
  expect(changed).toHaveBeenLastCalledWith(false);
  view.rerender(<SessionFeedback {...props} sendFailed />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("不同设置的详情各自返回对应设置入口", () => {
  const openSetting = vi.fn();
  render(<SessionFeedback pointer={{ hint: "", hintTone: "success", clearHint: vi.fn() }} orient={{ hint: "", clearHint: vi.fn() }}
    clipboard={clipboard} onSendFailDismiss={vi.fn()} onSettingOpen={openSetting}
    settings={[{ key: "quality", feedback: { tone: "error", title: "画质未能切换" } },
      { key: "audio", feedback: { tone: "error", title: "声音未能切换" } }]} />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "2 条提示" }));
  const audio = screen.getByText("声音未能切换").closest("section")!;
  fireEvent.click(within(audio).getByRole("button", { name: "查看设置" }));
  expect(openSetting).toHaveBeenCalledWith("audio");
});
