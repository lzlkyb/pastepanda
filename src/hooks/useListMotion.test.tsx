import { useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useListMotion } from "./useListMotion";
import { setMotionPreference } from "@/lib/motionPreference";

const cancels: ReturnType<typeof vi.fn>[] = [];
const measure = vi.fn(function (this: HTMLElement) {
  return { top: Number(this.dataset.pos ?? 0) } as DOMRect;
});
const animate = vi.fn(() => {
  const cancel = vi.fn(); cancels.push(cancel);
  return { cancel, finished: new Promise(() => {}) } as unknown as Animation;
});
beforeEach(() => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  setMotionPreference(true); cancels.length = 0; measure.mockClear(); animate.mockClear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(measure);
  vi.stubGlobal("Animation", class {});
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (Element.prototype as unknown as { animate?: unknown }).animate; });
function List({ items }: { items: { id: string }[] }) {
  const scroll = useRef<HTMLDivElement>(null);
  const { rowsWrapRef } = useListMotion(items, scroll);
  return <div ref={scroll} data-testid="scroll"><div ref={rowsWrapRef}>
    {items.slice(0, 3).map((item, index) => <div key={item.id} data-item-id={item.id}><div data-pos={index * 80}>{item.id}</div></div>)}
  </div></div>;
}

it("10,000 records measure and animate only the mounted rows during an insertion", () => {
  const items = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index) }));
  const { rerender, getByTestId } = render(<List items={items} />);
  expect(measure).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new CustomEvent("new-anim", { detail: { id: "new" } })));
  rerender(<List items={[{ id: "new" }, ...items]} />);
  expect(animate).toHaveBeenCalledTimes(3);
  expect(measure.mock.calls.length).toBeLessThanOrEqual(6);
  fireEvent.scroll(getByTestId("scroll"));
  cancels.forEach(cancel => expect(cancel).toHaveBeenCalledOnce());
});

it("virtual row recycling does not replay entry animations", () => {
  const { rerender } = render(<List items={[{ id: "a" }]} />);
  rerender(<List items={[{ id: "b" }]} />);
  expect(animate).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();
});

it("the application switch prevents imperative list work", () => {
  setMotionPreference(false);
  const { rerender } = render(<List items={[{ id: "a" }]} />);
  act(() => window.dispatchEvent(new CustomEvent("new-anim", { detail: { id: "b" } })));
  rerender(<List items={[{ id: "b" }, { id: "a" }]} />);
  expect(animate).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();
});
