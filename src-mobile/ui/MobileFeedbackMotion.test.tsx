import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileNotice } from "./MobileNotice";
import { MobileFeedbackSlot } from "./MobileFeedbackSlot";
import { setupMotionClock } from "./mobileMotionTestUtils";

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const cancel = vi.fn(), animate = vi.fn(() => ({ cancel }) as unknown as Animation);
beforeEach(() => { vi.useFakeTimers(); setupMotionClock(); animate.mockClear(); cancel.mockClear(); Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate }); });
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

it("状态更新只运行有限的内容淡入和高度过渡，隐藏时取消动画", () => {
  let height = 100;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ height } as DOMRect));
  const view = render(<MobileNotice tone="pending" title="正在连接" />);
  expect(animate.mock.calls).toHaveLength(1);
  height = 180;
  view.rerender(<MobileNotice tone="error" title="未能连接" detail="请检查连接状态，然后重试。" />);
  expect(animate.mock.calls).toContainEqual([[{ height: "100px" }, { height: "180px" }], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }]);
  expect(cancel).toHaveBeenCalledOnce();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(cancel).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("status").dataset.motionPaused).toBe("true");
});

it("收起保留最后一帧并禁用动作，200ms后移除；重新出现会取消旧退场", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 80 } as DOMRect);
  const view = render(<MobileFeedbackSlot><MobileNotice title="旧结果" action={<button>重试</button>} /></MobileFeedbackSlot>);
  view.rerender(<MobileFeedbackSlot>{null}</MobileFeedbackSlot>);
  expect(screen.getByText("旧结果").closest('[inert][aria-hidden="true"]')).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  act(() => vi.advanceTimersByTime(100));
  view.rerender(<MobileFeedbackSlot><MobileNotice title="新结果" /></MobileFeedbackSlot>);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("status").textContent).toBe("新结果");
  view.rerender(<MobileFeedbackSlot>{null}</MobileFeedbackSlot>);
  act(() => vi.advanceTimersByTime(199));
  expect(screen.getByText("新结果")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText("新结果")).toBeNull();
});

it("减少动态效果和隐藏页面保持完整内容，不创建动画", () => {
  const clock = setupMotionClock(); clock.reduced.matches = true;
  const view = render(<MobileFeedbackSlot><MobileNotice title="完整提示" /></MobileFeedbackSlot>);
  expect(screen.getByRole("status").textContent).toBe("完整提示");
  expect(animate).not.toHaveBeenCalled();
  view.rerender(<MobileFeedbackSlot>{null}</MobileFeedbackSlot>);
  expect(screen.queryByText("完整提示")).toBeNull();
});

it("原生诊断详情展开也触发高度过渡", () => {
  let height = 80;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ height } as DOMRect));
  render(<MobileNotice title="请求未完成" technical="已准备的安全诊断信息" />);
  height = 160;
  fireEvent(screen.getByText("查看详情").closest("details")!, new Event("toggle", { bubbles: true }));
  expect(animate.mock.calls).toContainEqual([[{ height: "80px" }, { height: "160px" }], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }]);
});
