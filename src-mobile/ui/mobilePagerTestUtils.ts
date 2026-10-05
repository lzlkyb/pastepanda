import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/** JSDOM 没有布局/滚动物理：只报告浏览器位置，不模拟原生手感。 */
export function setupPagerLayout(deferSmooth = false) {
  let width = 400;
  let resized: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
  if (!HTMLElement.prototype.scrollTo)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { value() {}, configurable: true, writable: true });
  const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
    this: HTMLElement,
    options: ScrollToOptions | number,
  ) {
    if (typeof options === "number" || (deferSmooth && options.behavior === "smooth")) return;
    const left = options.left ?? this.scrollLeft;
    if (left === this.scrollLeft) return;
    reportScroll(this, left, true);
  });
  return {
    scrollTo,
    disconnect,
    resize(nextWidth = width) {
      width = nextWidth;
      act(() => resized?.([], {} as ResizeObserver));
    },
  };
}

export function reportScroll(node: HTMLElement, left: number, ended = false) {
  act(() => {
    node.scrollLeft = left;
    fireEvent.scroll(node);
    if (ended) fireEvent(node, new Event("scrollend"));
  });
}
