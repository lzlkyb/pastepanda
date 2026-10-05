/**
 * useRemoteCursor 守卫测试——钉住「错了真机上一定出事」的三件事：
 *
 * ① 收到位置前**不显示**：没位置就画，光标会出现在左上角，用户会以为
 *    电脑光标真的在角落（比不显示更糟）；
 * ② x/y 缺省（对端藏了光标 / 旧版只发形状）→ 收起，绝不把光标摆在
 *    最后一次的位置继续说谎；
 * ③ 位置只写 DOM（left/top + isOn 类），不进 React state——25Hz 的更新
 *    量进 state 会把会话壳按 25fps 重渲染（画布/工具栏全跟着）。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { useRemoteCursor } from "./useRemoteCursor";
import { VIEWPORT_CHANGED } from "../video/PinchViewport";
const resizeCallbacks: (() => void)[] = [];

type Handler = (e: { payload: { shape: string; x?: number; y?: number } }) => void;

/** 画布矩形 200×100、内容 100×100（fit → 内容区 ox=50）。 */
function fakeCanvas(left = 0, top = 0) {
  return {
    getBoundingClientRect: () => ({ left, top, width: 200, height: 100, right: 0, bottom: 0, x: 0, y: 0 }),
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

/** 光标元素：记下每次 style 写入，供断言「位置是否走了 DOM」。 */
function fakeCursorEl() {
  const classes = new Set<string>();
  return {
    style: {} as CSSStyleDeclaration,
    offsetParent: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }) } as unknown as HTMLElement,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    _classes: classes,
  };
}

function setup() {
  const canvas = fakeCanvas();
  const el = fakeCursorEl();
  const canvasRef = { current: canvas as HTMLCanvasElement | null };
  const contentRef = { current: { w: 100, h: 100 } };
  const cursorRef = { current: el as unknown as HTMLDivElement | null };
  const surfaceRef = { current: document.createElement("div") as HTMLElement | null };
  const handlers: Handler[] = [];
  api.listen.mockImplementation(async (_evt: string, h: Handler) => {
    handlers.push(h);
    return () => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    };
  });
  const view = renderHook(() =>
    useRemoteCursor({ enabled: true, canvasRef, contentRef, cursorRef, surfaceRef }),
  );
  return { view, handlers, el, canvasRef, contentRef, cursorRef, surfaceRef };
}

beforeEach(() => {
  api.listen.mockReset();
  resizeCallbacks.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resizeCallbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useRemoteCursor", () => {
  it.each(["transform", "resize", "observer"] as const)("静止光标在 %s 后重新投影，无需新的遥测帧", kind => {
    const h = setup();
    act(() => h.handlers.forEach(handler => handler({ payload: { shape: "arrow", x: 65535, y: 65535 } })));
    expect(h.el.style.left).toBe("150px");
    h.canvasRef.current = fakeCanvas(40, 20);
    act(() => {
      if (kind === "transform") h.surfaceRef.current!.dispatchEvent(new Event(VIEWPORT_CHANGED));
      else if (kind === "resize") window.dispatchEvent(new Event("resize"));
      else resizeCallbacks.forEach(callback => callback());
    });
    expect(h.el.style.left).toBe("190px");
    expect(h.el.style.top).toBe("120px");
    act(() => h.handlers.forEach(handler => handler({ payload: { shape: "hidden" } })));
    act(() => h.surfaceRef.current!.dispatchEvent(new Event(VIEWPORT_CHANGED)));
    expect(h.view.result.current.placed).toBe(false);
    expect(h.el._classes.has("isOn")).toBe(false);
  });
  it("收到位置前不显示（isOn 不加，placed=false）", () => {
    const { view, el } = setup();
    expect(el._classes.has("isOn")).toBe(false);
    expect(view.result.current.placed).toBe(false);
  });

  it("形状 + 位置一起到 → 定位并显示（箭头形状也要画图形）", () => {
    const { view, handlers, el } = setup();
    act(() => handlers.forEach(h => h({ payload: { shape: "arrow", x: 65535, y: 65535 } })));
    // fit：ox=50、内容宽 100 → x 归一化最大 = 50+100 = 150
    expect(el.style.left).toBe("150px");
    expect(el.style.top).toBe("100px");
    expect(el._classes.has("isOn")).toBe(true);
    expect(view.result.current.shape).toBe("arrow");
    expect(view.result.current.placed).toBe(true);
  });

  it("I-beam 形状进 state（图形组件据此切换）", () => {
    const { view, handlers } = setup();
    act(() => handlers.forEach(h => h({ payload: { shape: "ibeam", x: 100, y: 100 } })));
    expect(view.result.current.shape).toBe("ibeam");
  });

  it("x/y 缺省（对端藏了光标 / 旧版只发形状）→ 收起，不留在旧位置", () => {
    const { view, handlers, el } = setup();
    act(() => handlers.forEach(h => h({ payload: { shape: "arrow", x: 1000, y: 1000 } })));
    expect(el._classes.has("isOn")).toBe(true);
    act(() => handlers.forEach(h => h({ payload: { shape: "hidden" } })));
    expect(el._classes.has("isOn")).toBe(false);
    expect(view.result.current.placed).toBe(false);
    // 位置留着不要紧（元素已收起），但 placed 必须为假
    expect(el.style.left).toBeDefined();
  });

  it("会话结束（enabled=false）→ 复位成箭头 + 收起", () => {
    const canvasRef = { current: fakeCanvas() as HTMLCanvasElement | null };
    const contentRef = { current: { w: 100, h: 100 } };
    const el = fakeCursorEl();
    const cursorRef = { current: el as unknown as HTMLDivElement | null };
    api.listen.mockImplementation(async () => () => {});
    const view = renderHook(
      (p: { enabled: boolean }) =>
        useRemoteCursor({ enabled: p.enabled, canvasRef, contentRef, cursorRef }),
      { initialProps: { enabled: true } },
    );
    act(() => view.rerender({ enabled: false }));
    expect(el._classes.has("isOn")).toBe(false);
    expect(view.result.current.shape).toBe("arrow");
  });
});
