/**
 * RecTimeline 守卫（设计稿 §05：自绘轨道）。
 *
 * 这条轨道的全部活儿是「指针 x → 时间 → 吸附 → 回调」，而它在 jsdom 里**天然测不了**：
 * jsdom 不做排版，`getBoundingClientRect()` 恒为全 0，除零会得到 NaN 并一路传进 range。
 * 所以这里按真实语义替它做一件事——给轨道一个已知的盒子（1000px 宽 / 1000ms 时长，
 * 于是 1px = 1ms，比例一眼可算），其余全部走真实事件与真实 `snapTrimRange`。
 *
 * 🔴 jsdom 没有 `PointerEvent`。不给构造器的话 `fireEvent.pointerDown` 会退化成普通
 * `Event`，`clientX` 直接丢——那时用例会在「拖了没反应」上红，红因却是环境而不是代码。
 * 这里用 `MouseEvent` 当构造器（真浏览器里 PointerEvent 本就继承 MouseEvent，
 * 我们只用到 clientX / pointerId），读屏与真实手势的差异不在本文件范围内。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Timeline } from "./RecTimeline";

if (!("PointerEvent" in globalThis)) {
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
}

/** 时长 1000ms、刻度在整百毫秒上：1px = 1ms，吸附结果可以手算。 */
const DURATION = 1000;
const KEYFRAMES = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

function mount(overrides: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const onChange = vi.fn();
  const onSeek = vi.fn();
  const utils = render(
    <Timeline
      duration={DURATION}
      keyframes={KEYFRAMES}
      range={{ inMs: 0, outMs: DURATION }}
      currentMs={0}
      disabled={false}
      onChange={onChange}
      onSeek={onSeek}
      {...overrides}
    />,
  );
  const track = utils.container.querySelector(".rec-pv-track") as HTMLElement;
  // jsdom 恒 0：按真实语义给一个盒子（宽 1000 ⇒ 1px = 1ms）
  track.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 30, width: 1000, height: 30, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return { ...utils, track, onChange, onSeek };
}

const handle = (container: HTMLElement, side: "in" | "out") =>
  container.querySelector(`.rec-pv-handle.${side}`) as HTMLElement;

describe("裁剪轨道：拖手柄 = 改保留段并吸附到关键帧", () => {
  it("拖起点到 307ms：吸附到 300ms，终点不动", () => {
    const { container, onChange } = mount();
    fireEvent.pointerDown(handle(container, "in"), { clientX: 0 });
    fireEvent.pointerMove(handle(container, "in"), { clientX: 307 });
    expect(onChange).toHaveBeenLastCalledWith({ inMs: 300, outMs: DURATION });
  });

  it("拖终点到 456ms：吸附到 500ms（宁多勿少，保留段 ⊇ 用户选段）", () => {
    const { container, onChange } = mount();
    fireEvent.pointerDown(handle(container, "out"), { clientX: DURATION });
    fireEvent.pointerMove(handle(container, "out"), { clientX: 456 });
    expect(onChange).toHaveBeenLastCalledWith({ inMs: 0, outMs: 500 });
  });

  it("拖手柄不会被轨道当成「点空白处移播放头」（手柄按下必须吞掉这次 seek）", () => {
    const { container, onChange, onSeek } = mount();
    fireEvent.pointerDown(handle(container, "in"), { clientX: 0 });
    fireEvent.pointerMove(handle(container, "in"), { clientX: 307 });
    expect(onChange).toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("拖轨道本身 = 移动播放头，且**不改**保留段", () => {
    const { track, onChange, onSeek } = mount();
    fireEvent.pointerDown(track, { clientX: 400 });
    fireEvent.pointerMove(track, { clientX: 640 });
    expect(onSeek).toHaveBeenLastCalledWith(640);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("松手后不再跟手（指针已经离开了轨道，仍在改范围就是 bug）", () => {
    const { container, onChange } = mount();
    const start = handle(container, "in");
    fireEvent.pointerDown(start, { clientX: 0 });
    fireEvent.pointerMove(start, { clientX: 307 });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(start);
    fireEvent.pointerMove(start, { clientX: 800 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("裁剪轨道：不可裁剪时必须是死的", () => {
  it("disabled 下按下与移动都不产生任何回调", () => {
    const { container, track, onChange, onSeek } = mount({ disabled: true });
    fireEvent.pointerDown(handle(container, "in"), { clientX: 0 });
    fireEvent.pointerMove(handle(container, "in"), { clientX: 300 });
    fireEvent.pointerDown(track, { clientX: 400 });
    fireEvent.pointerMove(track, { clientX: 700 });
    expect(onChange).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("轨道宽为 0（还没排版）时不产出 NaN —— 宁可不响应，也不把 NaN 传给裁剪", () => {
    const { container, track, onChange } = mount();
    track.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(handle(container, "in"), { clientX: 0 });
    fireEvent.pointerMove(handle(container, "in"), { clientX: 300 });
    // 语义：拿不到宽度就没有「位置」可言 ⇒ 一次回调都不该发生
    expect(onChange).not.toHaveBeenCalled();
  });

  it("轨道宽为 0 时拖动**不许**把已选保留段抹掉（无宽度 ≠ 用户拖到了最左）", () => {
    const { container, track, onChange } = mount({ range: { inMs: 300, outMs: 700 } });
    track.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(handle(container, "in"), { clientX: 300 });
    fireEvent.pointerMove(handle(container, "in"), { clientX: 900 });
    // 缺陷形态：无宽度时若把坐标折成 0，会把起点从 300 抹到 0，保留段当场少一半
    expect(onChange).not.toHaveBeenCalled();
  });
});
