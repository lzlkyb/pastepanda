/**
 * useImmersiveCapsule 守卫单测 —— 首次引导的相位机：
 * teaching（自动展开倒计时）→ hint（把手脉冲一次性提示）→ done（本会话不再打扰）。
 * 「本会话只教一次」与「用户任何主动交互都终结引导」是本组用例钉住的不变量。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAPSULE_TEACH_SECONDS, useImmersiveCapsule } from "./useImmersiveCapsule";

const layout = vi.hoisted(() => ({ landscape: false }));
vi.mock("../ui/useMobileLayout", () => ({ useMobileLayout: () => layout.landscape }));

beforeEach(() => {
  layout.landscape = false;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function setup(keyboardOpen = false) {
  const h = renderHook(({ kb }) => useImmersiveCapsule({ keyboardOpen: kb }), {
    initialProps: { kb: keyboardOpen },
  });
  const enter = () => act(() => { layout.landscape = true; h.rerender({ kb: keyboardOpen }); });
  const exit = () => act(() => { layout.landscape = false; h.rerender({ kb: keyboardOpen }); });
  return { ...h, enter, exit };
}

it("会话首次进横屏：自动展开倒计时教学，到点收回把手态进 hint", () => {
  const h = setup();
  expect(h.result.current.phase).toBe("idle");
  h.enter();
  expect(h.result.current.phase).toBe("teaching");
  expect(h.result.current.capsuleVisible).toBe(true);
  act(() => { vi.advanceTimersByTime(3000); });
  expect(h.result.current.secondsLeft).toBe(CAPSULE_TEACH_SECONDS - 3);
  act(() => { vi.advanceTimersByTime(CAPSULE_TEACH_SECONDS * 1000); });
  expect(h.result.current.phase).toBe("hint");
  expect(h.result.current.capsuleVisible).toBe(false);
});

it("教学期间主动收起：立即进 hint 且倒计时停止；主动打开后引导完成", () => {
  const h = setup();
  h.enter();
  act(() => { h.result.current.toggle(); }); // 收起
  expect(h.result.current.phase).toBe("hint");
  expect(h.result.current.capsuleVisible).toBe(false);
  const frozen = h.result.current.secondsLeft;
  act(() => { vi.advanceTimersByTime(5000); });
  expect(h.result.current.secondsLeft).toBe(frozen); // 倒计时已停
  act(() => { h.result.current.dismissHint(); }); // 点画面
  expect(h.result.current.phase).toBe("done");
  act(() => { h.result.current.toggle(); }); // 打开
  expect(h.result.current.capsuleVisible).toBe(true);
  act(() => { h.result.current.dismissHint(); }); // done 后 no-op
  expect(h.result.current.phase).toBe("done");
});

it("切回竖屏结束一切；再次横屏不重教、不自动展开", () => {
  const h = setup();
  h.enter();
  act(() => { vi.advanceTimersByTime(2000); });
  h.exit();
  expect(h.result.current.phase).toBe("done");
  expect(h.result.current.capsuleVisible).toBe(false);
  h.enter();
  expect(h.result.current.phase).toBe("done");
  expect(h.result.current.capsuleVisible).toBe(false);
  expect(h.result.current.secondsLeft).toBeLessThan(CAPSULE_TEACH_SECONDS);
});

it("键盘展开强制可见，但不改变相位", () => {
  const h = setup(true);
  expect(h.result.current.capsuleVisible).toBe(true);
  expect(h.result.current.phase).toBe("idle");
});
