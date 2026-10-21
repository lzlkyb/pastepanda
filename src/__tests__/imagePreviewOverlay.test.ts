// @vitest-environment jsdom
/**
 * 图片详情浮层的事件归属守卫。
 *
 * 背景（7.2.12 用户反馈「识别文字后选词复制，复制没成功」）：
 * 浮层与图片画布同处 viewport，`fsOverlayLayer` 只是 `pointer-events: none` 让位，
 * 面板本身 `auto`。所以点面板里的按钮时，mousedown 照样冒泡到 viewport 的
 * `handleOcrSelectStart`，那里 `setSelectedWordIndices(new Set())` 把已选词清空；
 * 同一手势里的 click 落下时「复制选中」已因 `size === 0` 变 disabled，事件不派发
 * ——用户看到的就是「点了复制，什么都没发生」。
 *
 * 这里钉住的是**判定在冒泡路径上真的能认出来**，而不只是函数返回布尔值：
 * mousedown 用 bubbles 派发，处理器从事件里读 target，模拟真实的冒泡时序。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isInsidePreviewOverlay } from "@/lib/imagePreviewOverlay";
import { shouldZoomImageWheel } from "@/lib/imagePreviewWheel";

/** 搭一棵与 ImagePreviewDialog 同形的树：viewport > (img, overlay > panel > button) */
function buildTree() {
  const viewport = document.createElement("div");
  const img = document.createElement("img");

  const overlay = document.createElement("div");
  overlay.dataset.imagePreviewOverlay = "";

  const panel = document.createElement("div");
  const button = document.createElement("button");
  const label = document.createElement("span");
  button.appendChild(label);
  panel.appendChild(button);
  overlay.appendChild(panel);

  viewport.append(img, overlay);
  document.body.appendChild(viewport);
  return { viewport, img, overlay, panel, button, label };
}

/** 把鼠标按下派发到某个元素，返回 viewport 处理器实际收到的 target */
function mousedownTargetAt(viewport: HTMLElement, el: Element): EventTarget | null {
  let seen: EventTarget | null = null;
  const probe = (e: Event) => { seen = e.target; };
  viewport.addEventListener("mousedown", probe);
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  viewport.removeEventListener("mousedown", probe);
  return seen;
}

describe("浮层内的按下不算框选起手", () => {
  it("面板按钮的 mousedown 冒泡到 viewport 时，判定仍认得它是浮层", () => {
    const { viewport, button } = buildTree();
    const target = mousedownTargetAt(viewport, button);
    expect(target).toBe(button);              // 冒泡确实把 target 原样带到 viewport
    expect(isInsidePreviewOverlay(target)).toBe(true);
  });

  it("按钮内的图标/文字（深层子元素）同样算浮层内", () => {
    const { viewport, label } = buildTree();
    expect(isInsidePreviewOverlay(mousedownTargetAt(viewport, label))).toBe(true);
  });

  it("面板本体与浮层容器本身也算浮层内（点空白不启动框选）", () => {
    const { panel, overlay } = buildTree();
    expect(isInsidePreviewOverlay(panel)).toBe(true);
    expect(isInsidePreviewOverlay(overlay)).toBe(true);
  });

  it("图片画布上的按下不受影响（框选照常起手）", () => {
    const { viewport, img } = buildTree();
    expect(isInsidePreviewOverlay(mousedownTargetAt(viewport, img))).toBe(false);
  });

  it("null / 非元素目标按画布处理（不因判空丢框选）", () => {
    expect(isInsidePreviewOverlay(null)).toBe(false);
    expect(isInsidePreviewOverlay({} as EventTarget)).toBe(false);
  });

  it("滚轮与按下共用同一判定（避免只改一处，面板里又缩放图片）", () => {
    const { button, img } = buildTree();
    expect(shouldZoomImageWheel(img)).toBe(true);
    expect(shouldZoomImageWheel(button)).toBe(false);
    expect(shouldZoomImageWheel(button)).toBe(!isInsidePreviewOverlay(button));
  });
});

/**
 * 接线守卫：上面证的是「判定认得浮层」，这条补「框选起手真的问过判定」。
 * 判定函数写对了却没人调用，症状与没修一样（清空照旧），而这类漏接
 * 类型检查和渲染测试都抓不到。纯静态断言，属于防删守卫，不构成行为证明。
 */
describe("框选起手必须先问浮层判定", () => {
  it("handleOcrSelectStart 在清空已选词之前 guard 了浮层", () => {
    const src = readFileSync("src/hooks/useImagePreview.ts", "utf8");
    const start = src.indexOf("const handleOcrSelectStart");
    expect(start).toBeGreaterThan(-1);
    // 截到下一个 useCallback（handleOcrSelectMove）为止，只看这段函数体
    const body = src.slice(start, src.indexOf("const handleOcrSelectMove", start));
    const guardAt = body.indexOf("isInsidePreviewOverlay(e.target)");
    const clearAt = body.indexOf("setSelectedWordIndices(new Set())");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(clearAt); // guard 必须在清空之前
  });
});
