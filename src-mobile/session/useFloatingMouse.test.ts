import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFloatingMouse } from "./useFloatingMouse";
import { clampRcFloatingMousePosition } from "@/lib/utils";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const host = document.createElement("div"), root = document.createElement("div"), handle = document.createElement("button");
  host.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 400 }) as DOMRect;
  handle.setPointerCapture = vi.fn();
  const surfaceRef = { current: host };
  const callbacks = { point: () => ({ clientX: 300, clientY: 200 }), move: vi.fn(), reveal: vi.fn(), cancel: vi.fn() };
  const hook = renderHook(({ enabled }) => {
    const result = useFloatingMouse({ ...callbacks, surfaceRef, enabled });
    result.rootRef.current = root;
    result.handleRef.current = handle;
    return result;
  }, { initialProps: { enabled: true } });
  const emit = (name: string, x = 200, y = 200, id = 1) => act(() => handle.dispatchEvent(Object.assign(new Event(name), {
    pointerId: id, clientX: x, clientY: y, pointerType: "touch", button: 0,
  })));
  return { ...hook, ...callbacks, emit, root };
}

it("控制柄跟随内容指针定位，边缘约束不限制发送的鼠标位移", () => {
  const h = setup();
  expect(h.root.style.left).toBe("200px");
  expect(h.root.style.top).toBe("215px");
  h.emit("pointerdown");
  h.emit("pointermove", 900, 900);
  expect(h.move).toHaveBeenCalledWith(700, 700);
  expect(h.root.style.left).toBe("292px");
  expect(h.root.style.top).toBe("312px");
});

it("正常抬指不会解除按钮开启的拖拽，捕获中断才释放输入", () => {
  const h = setup();
  h.emit("pointerdown"); h.emit("pointerup"); h.emit("lostpointercapture");
  expect(h.cancel).not.toHaveBeenCalled();
  h.emit("pointerdown"); h.emit("lostpointercapture");
  expect(h.cancel).toHaveBeenCalledOnce();
  h.emit("pointermove", 250, 250);
  expect(h.move).not.toHaveBeenCalled();
});

it("只看、弹层或断流关闭输入时取消活动触点，之后不再移动", () => {
  const h = setup();
  h.emit("pointerdown");
  h.rerender({ enabled: false });
  expect(h.cancel).toHaveBeenCalledOnce();
  h.emit("pointermove", 250, 250);
  expect(h.move).not.toHaveBeenCalled();
});

it("第二根手指不接管活动控制柄，失焦后旧触点不能继续操作", () => {
  const h = setup();
  h.emit("pointerdown");
  h.emit("pointerdown", 300, 300, 2);
  h.emit("pointermove", 310, 310, 2);
  expect(h.move).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("blur")));
  h.emit("pointermove", 250, 250);
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.move).not.toHaveBeenCalled();
});

it("狭小窗口中的控制柄边界仍有限且落在可见范围", () => {
  expect(clampRcFloatingMousePosition(900, -100, 180, 140)).toEqual({ x: 90, y: 70 });
});

it("新增四个辅助按钮后，测量到的完整宽高约束保证边缘可达", () => {
  const position = clampRcFloatingMousePosition(900, 900, 390, 320, 280, 128);
  expect(position.x + 140).toBeLessThanOrEqual(390);
  expect(position.x - 140).toBeGreaterThanOrEqual(0);
  expect(position.y - 28 + 128).toBeLessThanOrEqual(320);
});
