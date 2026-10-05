import { afterEach, expect, it, vi } from "vitest";
import { createMobileSpring } from "./mobileSpring";
import { setupMotionClock } from "./mobileMotionTestUtils";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("反向切换保留当前位置和速度，旧关闭回调不再执行", () => {
  const clock = setupMotionClock(),
    draw = vi.fn(),
    close = vi.fn(),
    done = vi.fn();
  const spring = createMobileSpring(0, draw);
  spring.move(200, undefined, close);
  clock.advance(100);
  const before = spring.read();
  spring.move(0, undefined, done);
  expect(spring.read()).toEqual(before);
  clock.advance(1200);
  expect(close).not.toHaveBeenCalled();
  expect(done).toHaveBeenCalledTimes(1);
  expect(spring.read().position).toBe(0);
  expect(clock.frames.size).toBe(0);
  spring.dispose();
});
it("释放速度传给弹簧；动画中再次抓住不跳回起点", () => {
  const clock = setupMotionClock(),
    spring = createMobileSpring(40, () => {});
  spring.move(300, 900);
  expect(spring.read().velocity).toBe(900);
  clock.advance(16);
  const before = spring.read();
  expect(spring.stop()).toEqual(before);
  expect(clock.frames.size).toBe(0);
  spring.dispose();
});
it("减少动态效果立即到位，隐藏页面结束动画；dispose 移除订阅", () => {
  const clock = setupMotionClock(),
    spring = createMobileSpring(0, () => {});
  clock.reduced.matches = true;
  spring.move(100);
  expect(spring.read().position).toBe(100);
  expect(clock.frames.size).toBe(0);
  clock.reduced.matches = false;
  spring.move(300);
  clock.advance(16);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(spring.read().position).toBe(300);
  expect(clock.frames.size).toBe(0);
  spring.dispose();
  expect(clock.reduced.removeEventListener).toHaveBeenCalled();
});
it("不同刷新频率在同一经过时间得到同一位置", () => {
  const run = (step: number) => {
    const clock = setupMotionClock(),
      spring = createMobileSpring(0, () => {});
    spring.move(200);
    for (let i = 0; i < 240 / step; i++) clock.advance(step);
    const result = spring.read();
    spring.dispose();
    return result;
  };
  const slow = run(16),
    fast = run(8);
  expect(slow.position).toBeCloseTo(fast.position, 8);
  expect(slow.velocity).toBeCloseTo(fast.velocity, 8);
});
it("分页可以限制过冲并及时落定，共享弹簧默认仍保留原有回弹", () => {
  const clock = setupMotionClock(), done = vi.fn();
  const bounded = createMobileSpring(80, () => {}), original = createMobileSpring(80, () => {});
  bounded.move(100, 160, done, { min: 80, max: 100 });
  original.move(100, 160);
  let originalOvershot = false;
  for (let i = 0; i < 50; i++) {
    clock.advance(8);
    expect(bounded.read().position).toBeGreaterThanOrEqual(80);
    expect(bounded.read().position).toBeLessThanOrEqual(100);
    originalOvershot ||= original.read().position > 100;
  }
  expect(originalOvershot).toBe(true);
  expect(bounded.read()).toEqual({ position: 100, velocity: 0 });
  expect(done).toHaveBeenCalledTimes(1);
  bounded.dispose(); original.dispose();
  expect(clock.frames.size).toBe(0);
});
