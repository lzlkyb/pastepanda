import { afterEach, expect, it, vi } from "vitest";
import { createSceneMotion } from "./mobileSceneMotion";
import { setupMotionClock } from "./mobileMotionTestUtils";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const clock = setupMotionClock(), element = document.createElement("section");
  const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
  const animate = vi.fn(() => { const animation = { cancel: vi.fn(), onfinish: null }; animations.push(animation); return animation as unknown as Animation; });
  element.animate = animate;
  Object.defineProperty(element, "clientWidth", { value: 390 });
  return { clock, element, animations, animate };
}
it("连续切换取消旧动画，新目标与旧完成事件互不干扰", () => {
  const h = setup(), motion = createSceneMotion(h.element);
  motion.enter("forward"); motion.enter("back");
  expect(h.animations[0].cancel).toHaveBeenCalledOnce();
  h.animations[0].onfinish?.();
  expect(h.animations[1].cancel).not.toHaveBeenCalled();
  h.animations[1].onfinish?.();
  expect(h.animations[1].cancel).toHaveBeenCalledOnce();
  motion.dispose();
});
it("同一节点返回手势接管转场；迟到的旧清理不清掉新预览", () => {
  const h = setup(), old = createSceneMotion(h.element);
  old.enter("forward");
  const next = createSceneMotion(h.element);
  expect(h.animations[0].cancel).toHaveBeenCalledOnce();
  next.preview(0.5, "right"); const offset = h.element.style.getPropertyValue("--mobile-back-offset");
  old.dispose();
  expect(h.element.style.getPropertyValue("--mobile-back-offset")).toBe(offset);
  next.dispose();
  expect(h.element.style.getPropertyValue("--mobile-back-offset")).toBe("");
});
it("减少动态效果与后台立即停止转场，保留稳态", () => {
  const h = setup(), motion = createSceneMotion(h.element);
  motion.enter("tab");
  h.clock.reduced.matches = true;
  const preference = h.clock.reduced.addEventListener.mock.calls[0][1] as () => void; preference();
  expect(h.animations[0].cancel).toHaveBeenCalledOnce();
  motion.enter("back"); motion.preview(1, "left");
  expect(h.animate).toHaveBeenCalledTimes(1);
  expect(h.element.style.getPropertyValue("--mobile-back-offset")).toBe("0px");
  motion.dispose();
});
