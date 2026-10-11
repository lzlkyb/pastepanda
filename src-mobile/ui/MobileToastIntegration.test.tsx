import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileToast } from "./MobileToast";
import { MobileToastProvider } from "./MobileToastQueue";
import { MobileFeedbackScope } from "./MobileFeedbackScope";
import { setupMotionClock } from "./mobileMotionTestUtils";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("真实Toast一次只显示一条，后续结果从真正出现时开始计时", () => {
  vi.useFakeTimers(); setupMotionClock();
  const first = vi.fn(), next = vi.fn();
  render(<MobileToastProvider><MobileToast title="第一条" onDismiss={first} /><MobileToast title="第二条" onDismiss={next} /></MobileToastProvider>);
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByText("第二条")).toBeNull();
  act(() => vi.advanceTimersByTime(4200));
  expect(first).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toContain("第二条");
  act(() => vi.advanceTimersByTime(3999));
  expect(next).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(201));
  expect(next).toHaveBeenCalledOnce();
});

it("隐藏来源不发浮层，显示后登记，隐藏再次移除且不误调用关闭", async () => {
  setupMotionClock();
  const dismiss = vi.fn();
  const content = (hidden: boolean) => <MobileToastProvider><section hidden={hidden}><MobileToast title="已复制" onDismiss={dismiss} /></section></MobileToastProvider>;
  const view = render(content(true));
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => view.rerender(content(false)));
  expect(screen.getByRole("status").textContent).toContain("已复制");
  await act(async () => view.rerender(content(true)));
  expect(screen.queryByRole("status")).toBeNull();
  expect(dismiss).not.toHaveBeenCalled();
});

it("面板内的反馈自动保持在面板内，不参与页面浮层队列", () => {
  const clock = setupMotionClock(); clock.reduced.matches = true;
  const dismiss = vi.fn();
  render(<MobileToastProvider><section role="dialog"><MobileFeedbackScope><MobileToast title="已复制正文" onDismiss={dismiss} /></MobileFeedbackScope></section></MobileToastProvider>);
  expect(screen.getByRole("dialog").contains(screen.getByRole("status"))).toBe(true);
  expect(document.querySelector('[data-mobile-toast="floating"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(dismiss).toHaveBeenCalledOnce();
});

it("相同文案但恢复动作属于不同操作的结果不合并", () => {
  vi.useFakeTimers(); setupMotionClock();
  const first = vi.fn(), next = vi.fn();
  render(<MobileToastProvider><MobileToast title="文件已完成" action={<button>打开文件A</button>} onDismiss={first} />
    <MobileToast title="文件已完成" action={<button>打开文件B</button>} onDismiss={next} /></MobileToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  act(() => vi.advanceTimersByTime(200));
  expect(first).toHaveBeenCalledOnce();
  expect(next).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "打开文件B" })).toBeTruthy();
});
