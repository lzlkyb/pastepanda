import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileNotice } from "./MobileNotice";
import { MobileToast } from "./MobileToast";
import { setupMotionClock } from "./mobileMotionTestUtils";

afterEach(() => { cleanup(); delete document.body.dataset.mobileSheets; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("局部错误温和播报，只有显式紧迫信息才打断读屏", () => {
  const view = render(<MobileNotice tone="error" title="一个文件未完成" />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("一个文件未完成");
  view.rerender(<MobileNotice tone="error" urgency="assertive" title="画面已失效，输入已暂停" />);
  expect(screen.getByRole("alert").textContent).toContain("输入已暂停");
});

it("手动关闭先进入退出阶段，退出后才清理业务状态", () => {
  vi.useFakeTimers(); setupMotionClock();
  const dismiss = vi.fn();
  render(<MobileToast tone="success" title="已复制" onDismiss={dismiss} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(dismiss).not.toHaveBeenCalled();
  expect(screen.getByRole("status").closest('[data-state="closing"]')).toBeTruthy();
  act(() => vi.advanceTimersByTime(200));
  expect(dismiss).toHaveBeenCalledOnce();
});

it("带操作的成功结果留足阅读时间，错误仍不自动消失", () => {
  vi.useFakeTimers(); setupMotionClock();
  const dismiss = vi.fn();
  render(<MobileToast tone="success" title="文件已提交" action={<button>查看文件</button>} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(4000));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(2000));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(200));
  expect(dismiss).toHaveBeenCalledOnce();
});

it("标题相同但说明改变的新结果重新获得完整阅读时间", () => {
  vi.useFakeTimers(); setupMotionClock();
  const dismiss = vi.fn();
  const view = render(<MobileToast title="传输结果" detail="第一批文件完成" onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(5500));
  view.rerender(<MobileToast title="传输结果" detail="第二批文件完成" onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(1000));
  expect(dismiss).not.toHaveBeenCalled();
});

it("等待和错误不会被浮层自动过期规则误处理", () => {
  vi.useFakeTimers(); setupMotionClock();
  const dismiss = vi.fn();
  render(<MobileToast tone="error" title="接收目录未就绪" onDismiss={dismiss} />);
  expect(document.body.querySelector('[data-mobile-toast="floating"]')).toBeNull();
  act(() => vi.advanceTimersByTime(30000));
  expect(dismiss).not.toHaveBeenCalled();
});

it("减少动态效果时关闭即时完成，没有动画帧残留", () => {
  const clock = setupMotionClock(); clock.reduced.matches = true;
  const dismiss = vi.fn();
  render(<MobileToast title="已复制" onDismiss={dismiss} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(clock.frames.size).toBe(0);
});
