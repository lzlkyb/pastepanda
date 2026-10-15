import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileToastProvider, useMobileToastQueue, type MobileToastEntry, type MobileToastQueue } from "./MobileToastQueue";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup() {
  let queue!: MobileToastQueue;
  function Probe() { queue = useMobileToastQueue()!; return null; }
  const view = render(<MobileToastProvider><Probe /></MobileToastProvider>);
  return { view, get queue() { return queue; } };
}

function entry(queue: MobileToastQueue, id: string, identity = id, dismiss = vi.fn()): MobileToastEntry {
  return { id, identity, dismiss, render: () => <button onClick={() => queue.finish(id)}>{identity}</button> };
}

it("同屏只显示一个轻通知，完成后按原顺序显示下一条", () => {
  const { queue } = setup();
  const first = entry(queue, "a"), second = entry(queue, "b"), third = entry(queue, "c");
  act(() => { queue.enqueue(first); queue.enqueue(second); queue.enqueue(third); });
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["a"]);
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(first.dismiss).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["b"]);
  fireEvent.click(screen.getByRole("button", { name: "b" }));
  expect(screen.getByRole("button", { name: "c" })).toBeTruthy();
});

it("同结果合并，关闭一次清理所有存活来源且不再补播", () => {
  const { queue } = setup();
  const a = entry(queue, "a", "已复制"), b = entry(queue, "b", "已复制");
  act(() => { queue.enqueue(a); queue.enqueue(b); });
  expect(screen.getAllByRole("button", { name: "已复制" })).toHaveLength(1);
  act(() => { queue.finish("a"); queue.finish("a"); queue.finish("b"); });
  expect(a.dismiss).toHaveBeenCalledOnce();
  expect(b.dismiss).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button")).toBeNull();
});

it("等待队列最多三条，满时移除最早等待项但不打断当前项", () => {
  const { queue } = setup();
  const entries = ["a", "b", "c", "d", "e"].map(id => entry(queue, id));
  act(() => entries.forEach(item => queue.enqueue(item)));
  expect(entries[1].dismiss).toHaveBeenCalledOnce();
  expect(entries[0].dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["c"]);
});

it("等待超过二十秒的结果不补播，当前项可继续阅读", () => {
  vi.useFakeTimers();
  const { queue } = setup();
  const first = entry(queue, "a"), stale = entry(queue, "b"), fresh = entry(queue, "c");
  act(() => { queue.enqueue(first); queue.enqueue(stale); });
  act(() => vi.advanceTimersByTime(20001));
  expect(first.dismiss).not.toHaveBeenCalled();
  act(() => queue.enqueue(fresh));
  expect(stale.dismiss).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["c"]);
});

it("完成当前项时也检查等待结果的有效期，不需要定时轮询", () => {
  vi.useFakeTimers();
  const { queue } = setup();
  const stale = entry(queue, "b");
  act(() => { queue.enqueue(entry(queue, "a")); queue.enqueue(stale); });
  act(() => vi.advanceTimersByTime(20001));
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(screen.queryByRole("button")).toBeNull();
  expect(stale.dismiss).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("来源卸载只注销，不调用陈旧的关闭回调", () => {
  const dismiss = vi.fn();
  function Owner() {
    const queue = useMobileToastQueue()!;
    useEffect(() => { queue.enqueue(entry(queue, "owner", "owner", dismiss)); return () => queue.remove("owner"); }, [queue]);
    return null;
  }
  const view = render(<MobileToastProvider><Owner /></MobileToastProvider>);
  view.rerender(<MobileToastProvider>{null}</MobileToastProvider>);
  expect(screen.queryByRole("button")).toBeNull();
  expect(dismiss).not.toHaveBeenCalled();
});

it("已注销的重复来源不会在另一个来源关闭时收到回调", () => {
  const { queue } = setup();
  const a = entry(queue, "a", "已复制"), b = entry(queue, "b", "已复制");
  act(() => { queue.enqueue(a); queue.enqueue(b); queue.remove("a"); });
  fireEvent.click(screen.getByRole("button", { name: "已复制" }));
  expect(a.dismiss).not.toHaveBeenCalled();
  expect(b.dismiss).toHaveBeenCalledOnce();
});

it("同来源更新内容保留排队顺序且使用最新回调", () => {
  const { queue } = setup();
  const previous = entry(queue, "b", "旧结果"), latest = entry(queue, "b", "新结果");
  act(() => { queue.enqueue(entry(queue, "a")); queue.enqueue(previous); queue.enqueue(entry(queue, "c")); queue.enqueue(latest); });
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["新结果"]);
  fireEvent.click(screen.getByRole("button", { name: "新结果" }));
  expect(previous.dismiss).not.toHaveBeenCalled();
  expect(latest.dismiss).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "c" })).toBeTruthy();
});

it("同来源新结果重置显示组件生命周期，同结果更新不重挂载", () => {
  const { queue } = setup();
  const mounted = vi.fn(), unmounted = vi.fn();
  function Content({ text }: { text: string }) {
    useEffect(() => { mounted(); return unmounted; }, []);
    return <span>{text}</span>;
  }
  const make = (identity: string) => ({ id: "a", identity, dismiss: vi.fn(), render: () => <Content text={identity} /> });
  act(() => queue.enqueue(make("第一条")));
  act(() => queue.enqueue(make("第一条")));
  expect(mounted).toHaveBeenCalledTimes(1);
  act(() => queue.enqueue(make("第二条")));
  expect(mounted).toHaveBeenCalledTimes(2);
  expect(unmounted).toHaveBeenCalledOnce();
});

it("provider销毁不主动调用仍挂载来源的业务回调", () => {
  const { queue, view } = setup();
  const a = entry(queue, "a");
  act(() => queue.enqueue(a));
  view.unmount();
  expect(a.dismiss).not.toHaveBeenCalled();
  expect(screen.queryByRole("button")).toBeNull();
});

it("等待项的重复结果合并后保持原队列位置", () => {
  const { queue } = setup();
  const b = entry(queue, "b", "已保存"), duplicate = entry(queue, "duplicate", "已保存");
  act(() => { queue.enqueue(entry(queue, "a")); queue.enqueue(b); queue.enqueue(entry(queue, "c")); queue.enqueue(duplicate); });
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["已保存"]);
  fireEvent.click(screen.getByRole("button", { name: "已保存" }));
  expect(b.dismiss).toHaveBeenCalledOnce();
  expect(duplicate.dismiss).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "c" })).toBeTruthy();
});

it("同来源新结果刷新等待时间，不因旧结果过期而清掉新结果", () => {
  vi.useFakeTimers();
  const { queue } = setup();
  const previous = entry(queue, "b", "旧结果"), latest = entry(queue, "b", "刚刚完成");
  act(() => { queue.enqueue(entry(queue, "a")); queue.enqueue(previous); });
  act(() => vi.advanceTimersByTime(20001));
  act(() => queue.enqueue(latest));
  expect(previous.dismiss).not.toHaveBeenCalled();
  expect(latest.dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(screen.getByRole("button", { name: "刚刚完成" })).toBeTruthy();
});

it("同结果更新使用最新内容与回调，context方法引用保持稳定", () => {
  const test = setup();
  const { queue } = test;
  const previous = entry(queue, "a", "结果"), latest = entry(queue, "a", "结果");
  latest.render = () => <button onClick={() => queue.finish("a")}>最新说明</button>;
  act(() => queue.enqueue(previous));
  act(() => queue.enqueue(latest));
  expect(test.queue).toBe(queue);
  expect(screen.queryByRole("button", { name: "结果" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "最新说明" }));
  expect(previous.dismiss).not.toHaveBeenCalled();
  expect(latest.dismiss).toHaveBeenCalledOnce();
});

it("关闭回调同步重入也只能执行一次，并可登记新结果", () => {
  const { queue } = setup();
  const dismiss = vi.fn(() => { queue.finish("a"); queue.enqueue(entry(queue, "b")); });
  act(() => queue.enqueue(entry(queue, "a", "a", dismiss)));
  fireEvent.click(screen.getByRole("button", { name: "a" }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "b" })).toBeTruthy();
});
