import { useEffect, useRef, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Lenis from "lenis";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { HistoryItem } from "@/stores/appStore";
import { useVirtualScroll } from "./useVirtualScroll";

const { scrollTo, destroy } = vi.hoisted(() => ({ scrollTo: vi.fn(), destroy: vi.fn() }));
vi.mock("lenis", () => ({ default: class {
  scrollTo = scrollTo;
  destroy = destroy;
  on = vi.fn();
  raf = vi.fn();
} }));
const items = ["a", "b", "c"].map(id => ({ id })) as HistoryItem[];
const offsets = vi.fn((index: number) => [index * 80, "auto"]);
const virtualizer = { getOffsetForIndex: offsets } as unknown as Virtualizer<HTMLDivElement, Element>;
const loadMore = vi.fn();
function Harness({ mounted = ["a", "b", "c"], focusOverride }: { mounted?: string[]; focusOverride?: string | null }) {
  const scrollRef = useRef<HTMLDivElement>(null), lenisRef = useRef<Lenis | null>(null);
  const [current, setCurrent] = useState("a");
  const { contentRef } = useVirtualScroll({ scrollRef, lenisRef, items, virtualizer, triggerLoadMore: loadMore, focusId: focusOverride === undefined ? current : focusOverride });
  useEffect(() => {
    const onNavigate = (event: Event) => setCurrent((event as CustomEvent).detail.id);
    window.addEventListener("app-scroll-to-item", onNavigate);
    return () => window.removeEventListener("app-scroll-to-item", onNavigate);
  }, []);
  return <div ref={scrollRef} tabIndex={-1} role="listbox"><div ref={contentRef}>{mounted.map(id => <div data-item-id={id} key={id}>
    <div className="cardWrap"><div className="card" role="option" tabIndex={-1} aria-label={id} /></div>
  </div>)}</div></div>;
}
const navigate = (id: string) => act(() => window.dispatchEvent(new CustomEvent("app-scroll-to-item", { detail: { id } })));
beforeEach(() => { vi.useFakeTimers(); scrollTo.mockClear(); destroy.mockClear(); offsets.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("键盘导航立即移动 DOM 焦点，快速切换后不向外层注入方形高亮", () => {
  const { container } = render(<Harness />);
  navigate("b");
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "b" }));
  navigate("c");
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "c" }));
  act(() => vi.advanceTimersByTime(900));
  expect([...container.querySelectorAll<HTMLElement>(".cardWrap,.card")].every(el => !el.style.boxShadow)).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "c" }));
});

it("即使没有聚焦回调，也不再在滚动完成后画第二层框", () => {
  const { container } = render(<Harness />);
  navigate("a");
  act(() => vi.advanceTimersByTime(900));
  expect(container.querySelector<HTMLElement>(".cardWrap")!.style.boxShadow).toBe("");
});

it("目标虚拟行挂载后聚焦最新目标，不抢走范围外的控件焦点", () => {
  const other = document.createElement("button"); document.body.append(other); other.focus();
  const { rerender } = render(<Harness mounted={["a"]} />);
  navigate("b"); navigate("c");
  rerender(<Harness mounted={["b", "c"]} />);
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "c" }));
  other.remove();
});

it("卸载取消漂移校正，不调用已销毁的滚动引擎", () => {
  const { unmount } = render(<Harness />);
  navigate("b");
  offsets.mockImplementationOnce(() => [400, "auto"]);
  const before = scrollTo.mock.calls.length;
  unmount(); act(() => vi.advanceTimersByTime(1000));
  expect(scrollTo).toHaveBeenCalledTimes(before);
  expect(destroy).toHaveBeenCalledOnce();
});

it("清除当前位置后焦点回到列表，待挂载目标不再抢回焦点", () => {
  const { rerender } = render(<Harness />);
  navigate("b");
  rerender(<Harness focusOverride={null} />);
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  rerender(<Harness mounted={["a"]} />);
  navigate("c");
  rerender(<Harness mounted={["a"]} focusOverride={null} />);
  rerender(<Harness mounted={["a", "c"]} focusOverride={null} />);
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
});
