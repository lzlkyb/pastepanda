import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileNotice } from "./MobileNotice";
import { MobileToast } from "./MobileToast";

afterEach(() => { cleanup(); delete document.body.dataset.mobileSheets; vi.useRealTimers(); vi.restoreAllMocks(); });

it("错误有警报语义，处理状态不宣称完成；关闭和恢复动作独立", () => {
  const dismiss = vi.fn(), retry = vi.fn();
  const view = render(<MobileNotice tone="error" title="未能连接" detail="请检查连接状态" onDismiss={dismiss}
    action={<button onClick={retry}>重试</button>} technical="请求未完成，错误类别：连接中断" />);
  expect(screen.getByRole("alert").textContent).toContain("请检查连接状态");
  const details = screen.getByText("查看详情").closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(dismiss).toHaveBeenCalledTimes(1);
  view.rerender(<MobileNotice tone="pending" title="正在连接…" />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
});

it.each(["error", "warning", "pending"] as const)("%s 提示不会自动消失", tone => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  render(<MobileToast tone={tone} title="操作结果" onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(30000));
  expect(dismiss).not.toHaveBeenCalled();
});

it("当前面板内的成功提示到时收起，被面板覆盖的页面提示保留", () => {
  vi.useFakeTimers(); document.body.dataset.mobileSheets = "1";
  const visible = vi.fn(), covered = vi.fn();
  render(<><MobileToast placement="flow" tone="success" title="页面结果" onDismiss={covered} />
    <section role="dialog" data-state="open"><MobileToast placement="flow" tone="success" title="面板结果" onDismiss={visible} /></section></>);
  act(() => vi.advanceTimersByTime(4000));
  expect(visible).toHaveBeenCalledOnce();
  expect(covered).not.toHaveBeenCalled();
});

it("成功轻提示聚焦暂停，离开后使用剩余阅读时间", () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  render(<MobileToast tone="success" title="已配对" onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(2500));
  const close = screen.getByRole("button", { name: "关闭提示" });
  fireEvent.focus(close);
  act(() => vi.advanceTimersByTime(10000));
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.blur(close);
  act(() => vi.advanceTimersByTime(1499));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it("后台暂停计时，卸载清理计时器", () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const view = render(<MobileToast tone="info" title="已取消" onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(1000));
  act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  act(() => vi.advanceTimersByTime(10000));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  act(() => vi.advanceTimersByTime(2999));
  expect(dismiss).not.toHaveBeenCalled();
  view.unmount();
  act(() => vi.advanceTimersByTime(10000));
  expect(dismiss).not.toHaveBeenCalled();
});

it("浮动提示避开滑动页面的坐标系，会话提示仍占据本地空间", () => {
  const view = render(<div data-testid="page"><MobileToast title="已配对" onDismiss={vi.fn()} /></div>);
  expect(screen.getByTestId("page").contains(screen.getByRole("status"))).toBe(false);
  view.rerender(<div data-testid="page"><MobileToast placement="flow" title="已配对" onDismiss={vi.fn()} /></div>);
  expect(screen.getByTestId("page").contains(screen.getByRole("status"))).toBe(true);
});
it("被弹层挡住时保留剩余计时，弹层关闭后继续", async () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  render(<MobileToast tone="success" title="已切换" onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(2000));
  await act(async () => { document.body.dataset.mobileSheets = "1"; });
  act(() => vi.advanceTimersByTime(10000));
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => { delete document.body.dataset.mobileSheets; });
  act(() => vi.advanceTimersByTime(1999));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it("切去另一个主页面时保留提示阅读时间，返回后继续", async () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  const view = render(<section hidden={false}><MobileToast placement="flow" tone="success" title="本页已保存" onDismiss={dismiss} /></section>);
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => view.rerender(<section hidden><MobileToast placement="flow" tone="success" title="本页已保存" onDismiss={dismiss} /></section>));
  act(() => vi.advanceTimersByTime(10000));
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => view.rerender(<section hidden={false}><MobileToast placement="flow" tone="success" title="本页已保存" onDismiss={dismiss} /></section>));
  act(() => vi.advanceTimersByTime(3000));
  expect(dismiss).toHaveBeenCalledOnce();
});

it("浮动反馈只显示一条，错误优先；关闭同样结果会合并移除", () => {
  const success = vi.fn(), error = vi.fn(), duplicate = vi.fn();
  render(<><MobileToast title="已复制" tone="success" onDismiss={success} />
    <MobileToast title="连接失败" tone="error" onDismiss={error} />
    <MobileToast title="连接失败" tone="error" onDismiss={duplicate} /></>);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(error).toHaveBeenCalledOnce(); expect(duplicate).toHaveBeenCalledOnce();
  expect(success).not.toHaveBeenCalled();
});

it("阅读页用CSS隐藏列表时，列表上的提示也暂停到期", async () => {
  vi.useFakeTimers();
  const css = document.createElement("style"); css.textContent = '[data-reading="true"] .test-list {display:none}'; document.head.append(css);
  const dismiss = vi.fn();
  const view = render(<div data-reading="false"><section className="test-list"><MobileToast placement="flow" title="列表结果" onDismiss={dismiss} /></section></div>);
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => view.rerender(<div data-reading="true"><section className="test-list"><MobileToast placement="flow" title="列表结果" onDismiss={dismiss} /></section></div>));
  act(() => vi.advanceTimersByTime(10000));
  css.remove();
  expect(dismiss).not.toHaveBeenCalled();
});

it("旋转使响应式列表隐藏时重新判断可见性，计时暂停", () => {
  vi.useFakeTimers();
  const readStyle = window.getComputedStyle.bind(window); let narrow = false;
  vi.spyOn(window, "getComputedStyle").mockImplementation(node => node.classList.contains("responsive-list")
    ? { display: narrow ? "none" : "block", visibility: "visible" } as CSSStyleDeclaration : readStyle(node));
  const dismiss = vi.fn();
  render(<section className="responsive-list"><MobileToast placement="flow" title="宽屏列表提示" onDismiss={dismiss} /></section>);
  act(() => vi.advanceTimersByTime(1000));
  act(() => { narrow = true; window.dispatchEvent(new Event("resize")); });
  act(() => vi.advanceTimersByTime(10000));
  expect(dismiss).not.toHaveBeenCalled();
});
