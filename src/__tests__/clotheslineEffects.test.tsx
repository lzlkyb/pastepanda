import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { createEffects } from "../clothesline/effects.mjs";
const originalAnimate = Element.prototype.animate;
beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  if (originalAnimate) Element.prototype.animate = originalAnimate;
  else delete (Element.prototype as Partial<Element>).animate;
});
function setup() {
  document.body.innerHTML =
    '<div id="stage"><div id="layer"></div><div id="source" class="hang"><div class="frame"><div class="photo"></div></div></div><div id="end"></div></div>';
  const stage = document.getElementById("stage")!,
    layer = document.getElementById("layer")!,
    source = document.getElementById("source")!,
    end = document.getElementById("end")!;
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
    x: 20,
    y: 30,
    left: 20,
    top: 30,
    width: 220,
    height: 210,
  } as DOMRect);
  vi.spyOn(end, "getBoundingClientRect").mockReturnValue({
    x: 320,
    y: 330,
    left: 320,
    top: 330,
    width: 45,
    height: 180,
  } as DOMRect);
  return { effects: createEffects({ stage, layer, reduced: () => false }), source, end, layer };
}
it("竖图取下图片使用等比缩放，纸框独立变形", async () => {
  const animate = vi
    .spyOn(Element.prototype, "animate")
    .mockImplementation(() => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation);
  const { effects, source, end } = setup();
  await effects.transfer("a", effects.capture(source), end, "pin");
  const keys = animate.mock.calls[animate.mock.calls.length - 1][0] as Keyframe[];
  expect(keys[1].transform).toMatch(/scale\([\d.]+\)$/);
  expect(keys[1]).not.toHaveProperty('width');
  expect(keys[1]).not.toHaveProperty('height');
});
it("撤销大风取消尚未卸重的计时器与动画副本", async () => {
  vi.useFakeTimers();
  vi.spyOn(Element.prototype, "animate").mockImplementation(() => {
    let reject!: (error: Error) => void;
    const finished = new Promise<Animation>((_, no) => {
      reject = no;
    });
    return { finished, cancel: () => reject(new Error("cancelled")) } as unknown as Animation;
  });
  const { effects, source, layer } = setup(),
    release = vi.fn();
  const result = effects.gale("a", source, 7, release);
  effects.cancel("a");
  await result;
  vi.advanceTimersByTime(3000);
  expect(release).not.toHaveBeenCalled();
  expect(layer.children.length).toBe(0);
});
it('取挂动画逐帧只改变合成属性，不动画布局尺寸或 padding',async()=>{
 const animate=vi.spyOn(Element.prototype,'animate').mockImplementation(()=>({finished:Promise.resolve(),cancel:vi.fn()}) as unknown as Animation);
 const {effects,source,end}=setup();await effects.transfer('a',effects.capture(source),end,'pin');
 const keys=animate.mock.calls.flatMap(call=>call[0] as Keyframe[]);
 expect(keys.some(key=>['width','height','padding','marginTop'].some(prop=>prop in key))).toBe(false);
});
