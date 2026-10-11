import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useMobilePager } from "./useMobilePager";

const ids = ["devices", "files", "knowledge", "settings"] as const;
type Destination = typeof ids[number];
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
afterEach(() => {
  cleanup(); delete document.body.dataset.mobileSheets; delete document.body.dataset.mobileBack;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const reduced = { matches: false };
  vi.stubGlobal("matchMedia", () => reduced);
  let width = 390;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 0, right: width, width, height: 600 }) as DOMRect);
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  const scrollTo = vi.fn(function(this: HTMLElement, options: ScrollToOptions | number) {
    if (typeof options === "object" && options.behavior !== "smooth") this.scrollLeft = options.left ?? 0;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  const select = vi.fn(), click = vi.fn();
  function Fixture({ enabled }: { enabled: boolean }) {
    const [tab, setTab] = useState<Destination>("devices");
    const pager = useMobilePager(ids, tab, next => { select(next); setTab(next); }, enabled);
    return <><output data-testid="tab">{tab}</output>
      <div data-testid="pager" ref={pager.contentRef} {...pager.events}>
        <button onClick={click}>内容动作</button><input aria-label="搜索" />
        <div data-testid="horizontal">横滚内容</div><div data-testid="owner" data-mobile-gesture-owner="image">图片手势</div>
      </div><button onClick={() => pager.navigate("files")}>文件</button>
      <button onClick={() => pager.navigate("knowledge")}>知识库</button><button onClick={() => pager.navigate("settings")}>设置</button>
      <button onClick={() => setTab("knowledge")}>业务导航</button></>;
  }
  const view = render(<Fixture enabled />), node = view.getByTestId("pager");
  function start(x = 100, target: HTMLElement = node, count = 1) {
    fireEvent.touchStart(target, { touches: Array.from({ length: count }, () => ({ clientX: x, clientY: 100 })) });
  }
  // Synthetic touchend still carries the actual remaining touch count.
  function release(cancel = false) {
    const event = new Event(cancel ? "touchcancel" : "touchend", { bubbles: true });
    Object.defineProperty(event, "touches", { value: [] }); fireEvent(window, event);
  }
  function position(left: number) { node.scrollLeft = left; fireEvent.scroll(node); }
  function settle() { fireEvent(node, new Event("scrollend")); }
  return { ...view, node, select, click, reduced, scrollTo, start, release, position, settle,
    changeSize: (next: number) => { width = next; act(() => resize()); },
    disable: () => view.rerender(<Fixture enabled={false} />) };
}

it("拖动途中和未落定时不切业务页，松手整页落定才激活", () => {
  const h = setup(); h.start(); h.position(220); h.settle();
  expect(h.select).not.toHaveBeenCalled(); expect(h.node.dataset.moving).toBe("true");
  h.release(); h.settle(); expect(h.select).not.toHaveBeenCalled();
  h.position(390); h.settle();
  expect(h.select).toHaveBeenCalledExactlyOnceWith("files"); expect(h.node.dataset.moving).toBe("false");
});
it("连续点击以最新目标为准，旧 scrollend 不激活旧目标", () => {
  const h = setup(); fireEvent.click(h.getByText("文件")); h.position(420);
  fireEvent.click(h.getByText("知识库")); h.position(390); h.settle();
  expect(h.select).not.toHaveBeenCalled();
  h.position(780); h.settle(); expect(h.select).toHaveBeenCalledExactlyOnceWith("knowledge");
  fireEvent.click(h.getByText("设置")); h.position(1170); h.settle();
  expect(h.getByTestId("tab").textContent).toBe("settings");
});
it("跨多页点击直接到目标，减少动态效果也不穿过中间页", () => {
  const h = setup(); fireEvent.click(h.getByText("设置"));
  expect(h.select).toHaveBeenCalledExactlyOnceWith("settings"); expect(h.node.scrollLeft).toBe(1170);
  h.reduced.matches = true; fireEvent.click(h.getByText("知识库"));
  expect(h.node.scrollLeft).toBe(780); expect(h.getByTestId("tab").textContent).toBe("knowledge");
});
it.each([5, 385])("系统边缘 %s 的触摸不切主导航", x => {
  const h = setup(); h.start(x); h.position(390); h.release(); h.settle();
  expect(h.node.scrollLeft).toBe(0); expect(h.select).not.toHaveBeenCalled();
});
it.each(["搜索", "owner", "horizontal"])("局部控件 %s 拥有自己的手势", target => {
  const h = setup(); const element = target === "搜索" ? h.getByLabelText(target) : h.getByTestId(target);
  if (target === "horizontal") {
    Object.defineProperties(element, { scrollWidth: { value: 600 }, clientWidth: { value: 200 } });
    element.style.overflowX = "auto";
  }
  h.start(100, element); h.position(390); h.release(); h.settle();
  expect(h.select).not.toHaveBeenCalled(); expect(h.node.scrollLeft).toBe(0);
});
it("多指与系统取消回到当前页，不留下延时切换", () => {
  const h = setup(); h.start(100, h.node, 2); h.position(390); h.release(); h.settle();
  expect(h.select).not.toHaveBeenCalled();
  h.start(); h.position(240); h.release(true); act(() => vi.advanceTimersByTime(500));
  expect(h.node.scrollLeft).toBe(0); expect(h.select).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("详情或远控接管时取消横滑，外部业务导航直接对齐", () => {
  const h = setup(); h.start(); h.position(300); h.disable(); h.release(); h.settle();
  expect(h.select).not.toHaveBeenCalled(); expect(h.node.scrollLeft).toBe(0);
  fireEvent.click(h.getByText("业务导航")); expect(h.node.scrollLeft).toBe(780);
});
it.each(["mobileSheets", "mobileBack"])("%s 接管时终止在途分页", async key => {
  const h = setup(); h.start(); h.position(280);
  await act(async () => { document.body.dataset[key] = "true"; await Promise.resolve(); });
  h.release(); h.settle(); expect(h.select).not.toHaveBeenCalled(); expect(h.node.scrollLeft).toBe(0);
});
it("宽度改变重定位，纯高度变化不截断触摸，卸载清理定时器", () => {
  const h = setup(); h.start(); h.position(280); h.changeSize(390);
  expect(h.node.scrollLeft).toBe(280); h.changeSize(650);
  expect(h.node.scrollLeft).toBe(0); expect(h.select).not.toHaveBeenCalled();
  h.start(); h.position(350); h.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it("隐藏和系统返回中断不在后台继续导航", () => {
  const h = setup(); h.start(); h.position(300);
  fireEvent(window, new Event("mobile-interaction-cancel")); h.release(); h.settle();
  expect(h.select).not.toHaveBeenCalled(); expect(h.node.scrollLeft).toBe(0);
  h.start(); h.position(300); vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange")); expect(vi.getTimerCount()).toBe(0);
});
it("滑动产生的点击被屏蔽，新触摸和键盘仍可操作", () => {
  const h = setup(); h.start(); h.position(180); h.release();
  fireEvent.click(h.getByText("内容动作"), { detail: 1 }); expect(h.click).not.toHaveBeenCalled();
  h.position(0); h.settle(); fireEvent.click(h.getByText("内容动作"), { detail: 0 }); expect(h.click).toHaveBeenCalledOnce();
  h.start(100, h.getByText("内容动作")); h.release();
  fireEvent.click(h.getByText("内容动作"), { detail: 1 }); expect(h.click).toHaveBeenCalledTimes(2);
});
it("新的鼠标或笔点击也能解除上次滑动的点击抑制", () => {
  const h = setup(); h.start(); h.position(180); h.release(); h.position(0); h.settle();
  fireEvent.pointerDown(h.getByText("内容动作"));
  fireEvent.click(h.getByText("内容动作"), { detail: 1 }); expect(h.click).toHaveBeenCalledOnce();
});
it("没有 scrollend 的旧 WebView 也在停止滚动后精确落定", () => {
  const h = setup(); h.start(); h.position(240); h.release();
  act(() => vi.advanceTimersByTime(320));
  expect(h.node.scrollLeft).toBe(390); expect(h.select).toHaveBeenCalledExactlyOnceWith("files");
  expect(vi.getTimerCount()).toBe(0);
});
it("局部横滚松手后的迟到滚动不能接管分页，下一次普通触摸可切页", () => {
  const h = setup(), local = h.getByTestId("horizontal");
  Object.defineProperties(local, { scrollWidth: { value: 600 }, clientWidth: { value: 200 } }); local.style.overflowX = "auto";
  h.start(100, local); h.release(); h.position(390); h.settle();
  expect(h.select).not.toHaveBeenCalled(); expect(h.node.scrollLeft).toBe(0);
  h.start(); h.position(390); h.release(); h.settle();
  expect(h.select).toHaveBeenCalledExactlyOnceWith("files");
});
