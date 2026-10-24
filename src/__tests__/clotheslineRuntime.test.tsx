import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountClothesline } from "../clothesline/runtime.mjs";
import type { Callbacks, Photo, Pin, Snapshot, Rect } from "../clothesline/bridge.mjs";

const fixture = readFileSync("clothesline.html", "utf8").match(/<body>([\s\S]*?)<script/)![1];
const photos: Photo[] = Array.from({ length: 5 }, (_, i) => ({
  id: "photo-" + i,
  path: "C:/shots/" + i + ".png",
  name: "图片 " + i,
  source: "PastePanda 截图",
  width: 200,
  height: 120,
}));
let dispose: (() => void) | undefined;
const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
function fakeBridge() {
  let callbacks: Callbacks;
  const snapshot: Snapshot = {
    items: structuredClone(photos),
    enabled: true,
    wind: false,
    locked: false,
    anchors: null,
    workArea: { x: -1920, y: 80, width: 1440, height: 760 },
    scale: 1.25,
  };
  const pin: Pin = { hwnd: 42, generation: 7, path: photos[0].path, rect: { x: 0, y: 320, width: 200, height: 120 } };
  const bridge = {
    safe: (promise: Promise<unknown>) =>
      promise.catch((error) => document.dispatchEvent(new CustomEvent("clothesline-error", { detail: String(error) }))),
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(async (value: Callbacks) => {
      callbacks = value;
    }),
    prepare: vi.fn(async (p: Photo) => ({
      ...p,
      url: "data:image/png;base64,iVBORw0KGgo=",
      aspect: p.width / p.height,
    })),
    original: vi.fn(async (p: Photo) => p.path),
    photoForPin: vi.fn(async () => photos[0]),
    ready: vi.fn(async () => {}),
    reportError: vi.fn(async (_message: string) => {}),
    focusPreview: vi.fn(async () => {}),
    regions: vi.fn(async (_regions: Rect[], _dragging: boolean) => {}),
    config: vi.fn(async (_config: Record<string, unknown>) => {}),
    remove: vi.fn(async () => {}),
    restore: vi.fn(async (_items: Photo[]) => {}),
    order: vi.fn(async () => {}),
    idle: vi.fn(async () => {}),
    take: vi.fn(async (_photo: Photo, _rect: Pin["rect"]) => pin),
    dragTake: vi.fn(async (_photo: Photo, _rect: Pin["rect"]) => pin),
    startDrag: vi.fn(async (_pin: Pin, _rect: Rect, _held: boolean, _point?: {x:number; y:number}) => pin),
    showPin: vi.fn(async () => {}),
    closePin: vi.fn(async () => {}),
    returnPin: vi.fn(async () => photos[0]),
    logical: vi.fn((rect: Pin["rect"]) => rect),
    physical: vi.fn((rect: Pin["rect"]) => rect),
    manager: vi.fn(async () => {}),
    dispose: vi.fn(),
    emitUpdate: (next: Snapshot) => callbacks.update(next),
    emitClosed: (next: Pin) => callbacks.pinClosed(next),
    emitDrop: (next: Pin) => callbacks.pinDrop(next),
    emitPreview: (next: Pin | null) => callbacks.pinPreview(next),
    emitDismiss: () => callbacks.dismissPreview(),
    emitVisible: (value: boolean) => callbacks.visible(value),
    snapshotValue: snapshot,
    pin,
  };
  return bridge;
}
beforeEach(() => {
  document.body.innerHTML = fixture;
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 760, configurable: true });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});
const count = () => document.querySelectorAll("#hangs .hang").length;
const take = () => fireEvent.click(document.querySelector("#hangs .takeOne")!);
describe("晾衣绳真实控制器接收事务", () => {
  it("其它图片尚在按钮取下时，已有贴图挂回直接接收而不是被弹回", async () => {
    const bridge = fakeBridge(); let acknowledge!: (pin: Pin) => void;
    dispose = await mountClothesline(bridge);
    take();
    await waitFor(() => expect(bridge.showPin).toHaveBeenCalledOnce());
    bridge.take.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    take();
    await waitFor(() => expect(bridge.take).toHaveBeenCalledTimes(2));
    await bridge.emitDrop({...bridge.pin,force:true});
    // 只锁「正在处理的那一张」：别的照片在取下不拦这张挂回，也不再弹「请稍候」把它退回。
    expect(bridge.returnPin).toHaveBeenCalledOnce();
    expect(bridge.showPin).toHaveBeenCalledOnce();
    acknowledge({...bridge.pin,hwnd:43,generation:8,path:photos[1].path});
    await waitFor(() => expect(bridge.showPin).toHaveBeenCalledTimes(2));
  });
  it("原生确认返回前的快速Esc挂回不能丢失，登记完成后必须接收", async () => {
    const bridge = fakeBridge(); let acknowledge!: (pin: Pin) => void;
    bridge.startDrag.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    dispose = await mountClothesline(bridge);
    const card = document.querySelector('#hangs .hang') as HTMLElement;
    card.setPointerCapture = vi.fn(); card.hasPointerCapture = vi.fn(() => true); card.releasePointerCapture = vi.fn();
    const x = parseFloat(card.style.left), y = parseFloat(card.style.top), hangs = document.getElementById('hangs')!;
    const event = (dy: number) => ({button:0,pointerId:1,clientX:x,clientY:y+dy,target:card} as unknown as PointerEvent);
    hangs.onpointerdown!(event(0)); hangs.onpointermove!(event(120));
    await waitFor(() => expect(bridge.startDrag).toHaveBeenCalledOnce());
    await bridge.emitDrop({...bridge.pin,force:true});
    acknowledge(bridge.pin);
    await waitFor(() => expect(bridge.returnPin).toHaveBeenCalledOnce());
    expect(count()).toBe(5);
  });
  it("大图挂回按鼠标靠绳判断，进入64px、退出96px，图片上沿无需对齐", async () => {
    const bridge = fakeBridge(); dispose = await mountClothesline(bridge);
    const card = document.querySelector('#hangs .hang') as HTMLElement;
    const x = parseFloat(card.style.left), y = parseFloat(card.style.top);
    const pin = { ...bridge.pin, rect: { x: x - 600, y: -600, width: 1200, height: 800 } };
    await bridge.emitPreview({ ...pin, point: [x, y + 56] });
    expect(document.getElementById('slotMarker')!.hidden).toBe(false);
    await bridge.emitPreview({ ...pin, point: [x, y + 80] });
    expect(document.getElementById('slotMarker')!.hidden).toBe(false);
    await bridge.emitPreview({ ...pin, point: [x, y + 120] });
    expect(document.getElementById('slotMarker')!.hidden).toBe(true);
  });
  it("慢缩略图不阻塞首次显示，加载前后照片位置保持一致", async () => {
    const bridge = fakeBridge();
    let complete!: (photo: Photo & { url: string; aspect: number }) => void;
    bridge.prepare.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const mounting = mountClothesline(bridge).then((cleanup) => { dispose = cleanup; });
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalled());
    await waitFor(() => expect(bridge.ready).toHaveBeenCalledOnce(), { timeout: 150 });
    await mounting;
    const card = document.querySelector("#hangs .hang") as HTMLElement;
    const before = [card.style.left, card.style.top, card.style.getPropertyValue("--ih")];
    expect(count()).toBe(5);
    complete({ ...photos[4], url: "ready.png", aspect: photos[4].width / photos[4].height });
    await waitFor(() => expect(document.querySelector('#hangs [data-id="photo-4"] img')).not.toBeNull());
    expect([card.style.left, card.style.top, card.style.getPropertyValue("--ih")]).toEqual(before);
  });
  it("原图准备期间继续跟手，提前松手后只落贴图，不再交付应用", async () => {
    const bridge = fakeBridge();
    let complete!: (pin: Pin) => void;
    bridge.dragTake.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    dispose = await mountClothesline(bridge);
    const card = document.querySelector("#hangs .hang") as HTMLElement;
    card.setPointerCapture = vi.fn(); card.hasPointerCapture = vi.fn(() => true); card.releasePointerCapture = vi.fn();
    const x = parseFloat(card.style.left), y = parseFloat(card.style.top);
    const event = (dx: number, dy: number) => ({ button: 0, pointerId: 1, clientX: x + dx, clientY: y + dy, target: card } as unknown as PointerEvent);
    const hangs = document.getElementById("hangs")!;
    await waitFor(() => expect(bridge.regions).toHaveBeenCalled());
    bridge.regions.mockClear();
    hangs.onpointerdown!(event(0, 0));
    await waitFor(() => expect(bridge.regions.mock.calls[bridge.regions.mock.calls.length - 1]?.[1]).toBe(true));
    hangs.onpointermove!(event(10, 120));
    expect(card.releasePointerCapture).not.toHaveBeenCalled();
    hangs.onpointermove!(event(100, 200));
    expect(card.style.left).toBe(x + 100 + "px");
    expect(count()).toBe(5);
    expect(document.querySelectorAll("#fxLayer > *")).toHaveLength(0);
    hangs.onpointerup!(event(100, 200));
    // 过程提示已按「安静优先」移除：松手不弹 toast，后文用 startDrag 的 held=false 验证语义。
    expect(document.getElementById("toast")!.hidden).toBe(true);
    await waitFor(() => expect(bridge.regions.mock.calls[bridge.regions.mock.calls.length - 1]?.[1]).toBe(false));
    bridge.emitUpdate({ ...bridge.snapshotValue, items: bridge.snapshotValue.items.slice(1) });
    expect(card.style.left).toBe(x + 100 + "px");
    complete(bridge.pin);
    await waitFor(() => expect(bridge.startDrag).toHaveBeenCalledWith(bridge.pin, expect.any(Object), false, { x: x + 100, y: y + 200 }));
    expect(bridge.dragTake).toHaveBeenCalledOnce();
    expect(count()).toBe(4);
  });
  it("准备期间取消取下，晚到的贴图要关闭并恢复原照", async () => {
    const bridge = fakeBridge();
    let complete!: (pin: Pin) => void;
    bridge.dragTake.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    dispose = await mountClothesline(bridge);
    const card = document.querySelector('#hangs [data-id="photo-2"]') as HTMLElement;
    card.setPointerCapture = vi.fn(); card.hasPointerCapture = vi.fn(() => true); card.releasePointerCapture = vi.fn();
    const x = parseFloat(card.style.left), y = parseFloat(card.style.top);
    const event = (dy: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y + dy, target: card } as unknown as PointerEvent);
    const hangs = document.getElementById("hangs")!;
    hangs.onpointerdown!(event(0)); hangs.onpointermove!(event(120));
    hangs.onpointercancel!(event(120));
    expect(card.style.top).toBe(y + "px");
    // 取消不再弹提示（照片回到原位本身就是反馈）。
    expect(document.getElementById("toast")!.hidden).toBe(true);
    complete(bridge.pin);
    await waitFor(() => expect(bridge.closePin).toHaveBeenCalledWith(bridge.pin));
    expect(bridge.restore).toHaveBeenCalledWith([expect.objectContaining({ id: photos[2].id })]);
    expect(bridge.order).toHaveBeenCalledWith(photos.map((photo) => photo.id));
    expect(bridge.startDrag).not.toHaveBeenCalled();
    expect(count()).toBe(5);
  });
  it("取下的连续拖动走原生交付，绳层隐藏不能提前显示大贴图", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    const card = document.querySelector("#hangs .hang") as HTMLElement;
    card.setPointerCapture = vi.fn(); card.hasPointerCapture = vi.fn(() => true); card.releasePointerCapture = vi.fn();
    const x = parseFloat(card.style.left), y = parseFloat(card.style.top);
    const event = (py: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: py, target: card } as unknown as PointerEvent);
    const hangs = document.getElementById("hangs")!;
    hangs.onpointerdown!(event(y)); hangs.onpointermove!(event(y + 120));
    expect(bridge.dragTake).toHaveBeenCalledOnce();
    expect(bridge.take).not.toHaveBeenCalled();
    await waitFor(() => expect(count()).toBe(4));
    bridge.emitVisible(false);
    expect(bridge.showPin).not.toHaveBeenCalled();
    hangs.onpointerup!(event(y + 120));
    expect(bridge.dragTake).toHaveBeenCalledOnce();
  });
  it("连续取下创建失败，原图保留在绳上并提示重试", async () => {
    const bridge = fakeBridge();
    bridge.dragTake.mockRejectedValue(new Error("模拟创建失败"));
    dispose = await mountClothesline(bridge);
    const card = document.querySelector("#hangs .hang") as HTMLElement;
    card.setPointerCapture = vi.fn(); card.hasPointerCapture = vi.fn(() => true); card.releasePointerCapture = vi.fn();
    const x = parseFloat(card.style.left), y = parseFloat(card.style.top);
    const event = (py: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: py, target: card } as unknown as PointerEvent);
    const hangs = document.getElementById("hangs")!;
    hangs.onpointerdown!(event(y)); hangs.onpointermove!(event(y + 120));
    await waitFor(() => expect(document.getElementById("toast")!.textContent).toContain("原图留在绳上"));
    expect(count()).toBe(5);
    expect(bridge.showPin).not.toHaveBeenCalled();
  });
  it("预览展开动画结束后刷新最终位置的原生命中区域", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() })),
    });
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    const loupe = document.getElementById("loupe")!;
    let finish!: () => void;
    vi.spyOn(loupe, "animate").mockReturnValue({
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      cancel: vi.fn(),
    } as unknown as Animation);
    const bounds = vi.spyOn(loupe, "getBoundingClientRect");
    const box = (x: number) =>
      ({ x, y: 200, left: x, top: 200, width: 560, height: 400, right: x + 560, bottom: 600 }) as DOMRect;
    bounds.mockReturnValue(box(400));
    fireEvent.keyDown(document.querySelector("#hangs .hang")!, { key: "Enter" });
    await waitFor(() => expect(bridge.regions.mock.calls.some(([r]) => r.some((p) => p.x === 400))).toBe(true));
    bridge.regions.mockClear();
    bounds.mockReturnValue(box(450));
    finish();
    await waitFor(() => expect(bridge.regions.mock.calls.some(([r]) => r.some((p) => p.x === 450))).toBe(true));
  });
  it("预览从照片位置展开，点内部保留、点外部关闭", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() })),
    });
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    const loupe = document.getElementById("loupe")!;
    const animation = vi.spyOn(loupe, "animate");
    fireEvent.keyDown(document.querySelector("#hangs .hang")!, { key: "Enter" });
    expect(loupe.hidden).toBe(false);
    expect(animation).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ duration: 300 }));
    fireEvent.pointerDown(document.getElementById("loupeImage")!);
    expect(loupe.hidden).toBe(false);
    fireEvent.pointerDown(document.getElementById("stage")!);
    expect(loupe.hidden).toBe(true);
    expect(document.getElementById("loupeImage")!.children).toHaveLength(0);
  });
  it("原生外部点击或绳层隐藏关闭预览，晚到的原图不能重新打开它", async () => {
    const bridge = fakeBridge();
    let finish!: (url: string) => void;
    bridge.original.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    dispose = await mountClothesline(bridge);
    const open = () => fireEvent.keyDown(document.querySelector("#hangs .hang")!, { key: "Enter" });
    open();
    bridge.emitDismiss();
    finish("late-original");
    await Promise.resolve();
    expect(document.getElementById("loupe")!.hidden).toBe(true);
    expect(document.getElementById("loupeImage")!.children).toHaveLength(0);
    open();
    bridge.emitVisible(false);
    expect(document.getElementById("loupe")!.hidden).toBe(true);
  });
  it("拖动端点跟手，停住鼠标后绳身仍有有限的弹性收敛", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() })),
    });
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    const left = document.getElementById("anchorLeft")!;
    Object.assign(left, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    for (const [type, x, y] of [
      ["pointerdown", 24, 32],
      ["pointermove", 100, 140],
    ] as const) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(left, event);
    }
    const path = document.getElementById("ropePath")!;
    expect(path.getAttribute("d")).toMatch(/^M100\.00,140\.00/);
    const moved = path.getAttribute("d");
    await waitFor(() => expect(path.getAttribute("d")).not.toBe(moved), { timeout: 150 });
  });
  it("隐藏窗口没有动画帧时仍能完成 ready 握手", async () => {
    // 原生窗口等待 ready 才显示；隐藏 WebView 不保证派发动画帧。
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    const bridge = fakeBridge();
    const mounted = mountClothesline(bridge);
    await waitFor(() => expect(bridge.ready).toHaveBeenCalled(), { timeout: 150 });
    dispose = await mounted;
  });
  it("拖动端点后保存固定坐标", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    const left = document.getElementById("anchorLeft")!;
    Object.assign(left, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    for (const [type, x, y] of [
      ["pointerdown", 24, 32],
      ["pointermove", 100, 140],
      ["pointerup", 100, 140],
    ] as const) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(left, event);
    }
    // 撤销已移除：拖动结果直接落盘，不会被一次误触回滚。
    expect(bridge.config).toHaveBeenCalled();
    const calls = bridge.config.mock.calls;
    const lastConfig = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(lastConfig).toHaveProperty("clothesline_anchors");
    expect(lastConfig.clothesline_anchors).not.toBeNull();
  });
  it("同一图片存在两张桌面贴图时，挂回只接收当前拖动的窗口", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    take();
    await waitFor(() => expect(bridge.showPin).toHaveBeenCalledTimes(1));
    await bridge.emitUpdate({ ...bridge.snapshotValue, items: photos });
    const second = { ...bridge.pin, hwnd: 43, generation: 8 };
    bridge.take.mockResolvedValueOnce(second);
    fireEvent.click(document.querySelector('#hangs [data-id="photo-0"] .takeOne')!);
    await waitFor(() => expect(bridge.showPin).toHaveBeenCalledTimes(2));
    const moved = { ...second, rect: { x: 500, y: 55, width: 200, height: 120 } };
    await bridge.emitDrop(moved);
    expect(bridge.returnPin).toHaveBeenCalledWith(
      expect.objectContaining({ hwnd: 43, generation: 8 }),
      "photo-0",
      expect.any(Number),
    );
  });
  it("静止时打开与关闭图片预览也更新鼠标命中区域", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    await waitFor(() => expect(bridge.regions).toHaveBeenCalled());
    bridge.regions.mockClear();
    vi.spyOn(document.getElementById("loupe")!, "getBoundingClientRect").mockReturnValue({
      x: 400,
      y: 200,
      left: 400,
      top: 200,
      width: 560,
      height: 320,
    } as DOMRect);
    fireEvent.keyDown(document.querySelector("#hangs .hang")!, { key: "Enter" });
    await waitFor(() =>
      expect(bridge.regions.mock.calls.some(([regions]) => regions.some((r) => r.x === 400 && r.y === 200))).toBe(true),
    );
    fireEvent.click(document.getElementById("closePreview")!);
    await waitFor(() =>
      expect(bridge.regions.mock.calls[bridge.regions.mock.calls.length - 1][0].some((r) => r.x === 400)).toBe(false),
    );
  });
  it("管理面板一键挂回可从绳带之外的位置启动同一转场", async () => {
    const bridge = fakeBridge();
    bridge.photoForPin.mockResolvedValue({ ...photos[0], id: "external-pin" });
    dispose = await mountClothesline(bridge);
    const far = { ...bridge.pin, rect: { x: 500, y: 500, width: 200, height: 120 } };
    await bridge.emitDrop(far);
    expect(bridge.returnPin).not.toHaveBeenCalled();
    await bridge.emitDrop({ ...far, force: true });
    expect(bridge.returnPin).toHaveBeenCalledWith(expect.objectContaining({ hwnd: 42 }), "external-pin", 5);
    expect(count()).toBe(6);
  });
  it("拖回预览取消或原生贴图关闭后解除整窗鼠标命中", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    const near = { ...bridge.pin, rect: { x: 500, y: 60, width: 200, height: 120 } };
    bridge.emitPreview(near);
    await waitFor(() => expect(bridge.regions.mock.calls[bridge.regions.mock.calls.length - 1]?.[1]).toBe(true));
    bridge.emitClosed(near);
    await waitFor(() => expect(document.getElementById("slotMarker")!.hidden).toBe(true));
  });
  it("批量收衣最多同时创建两张原生贴图且目标位置不重叠", async () => {
    const bridge = fakeBridge(),
      complete: (() => void)[] = [];
    bridge.take.mockImplementation(
      (photo, rect) =>
        new Promise((resolve) => complete.push(() => resolve({ ...bridge.pin, path: photo.path, rect }))),
    );
    dispose = await mountClothesline(bridge);
    fireEvent.click(document.querySelector("#gather")!);
    expect(bridge.take).toHaveBeenCalledTimes(2);
    const positions = bridge.take.mock.calls.map(([, rect]) => rect.x + "," + rect.y);
    expect(new Set(positions).size).toBe(2);
    complete.splice(0).forEach((done) => done());
    await waitFor(() => expect(bridge.take).toHaveBeenCalledTimes(4));
    complete.splice(0).forEach((done) => done());
    await waitFor(() => expect(bridge.take).toHaveBeenCalledTimes(5));
    complete.splice(0).forEach((done) => done());
    await waitFor(() => expect(count()).toBe(0));
  });
  it("原生窗口确认前不移除照片，创建失败保持源图片且可重试", async () => {
    const bridge = fakeBridge();
    let reject!: (e: Error) => void;
    bridge.take.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    dispose = await mountClothesline(bridge);
    take();
    expect(count()).toBe(5);
    expect(bridge.showPin).not.toHaveBeenCalled();
    // 单张在途不再锁批量按钮：旧版这里会整根绳子置灰，用户点不动。
    expect((document.querySelector("#clear") as HTMLButtonElement).disabled).toBe(false);
    reject(new Error("创建失败"));
    await waitFor(() => expect(document.querySelector("#toast")?.textContent).toContain("原图留在绳上"));
    expect(count()).toBe(5);
    take();
    await waitFor(() => expect(count()).toBe(4));
    await waitFor(() => expect(bridge.showPin).toHaveBeenCalledOnce());
  });
  it("同一历史图片取下后再次采集可以重新挂上", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    take();
    await waitFor(() => expect(count()).toBe(4));
    await bridge.emitUpdate({ ...bridge.snapshotValue, items: photos });
    expect(count()).toBe(5);
  });
  it("原生贴图挂回失败保留贴图，动画源使用最新松手位置", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    take();
    await waitFor(() => expect(bridge.showPin).toHaveBeenCalledOnce());
    bridge.returnPin.mockRejectedValueOnce(new Error("接收失败"));
    await bridge.emitDrop({ ...bridge.pin, rect: { x: 500, y: 55, width: 200, height: 120 } });
    expect(count()).toBe(4);
    expect(bridge.closePin).not.toHaveBeenCalled();
    expect((document.querySelector("#pins .pinGhost") as HTMLElement).style.left).toBe("500px");
    await bridge.emitDrop({ ...bridge.pin, rect: { x: 500, y: 55, width: 200, height: 120 } });
    expect(count()).toBe(5);
  });
  it("清空只发当次快照ID，之后新增的图片不受影响", async () => {
    const bridge = fakeBridge();
    dispose = await mountClothesline(bridge);
    fireEvent.click(document.querySelector("#clear")!);
    await waitFor(() => expect(count()).toBe(0));
    expect(bridge.remove).toHaveBeenCalledWith(photos.map((p) => p.id));
    // 撤销已移除：清空后新采集的图片照常出现，不会被一次回滚吞掉。
    await bridge.emitUpdate({ ...bridge.snapshotValue, items: [{ ...photos[0], id: "new-photo" }] });
    expect(count()).toBe(1);
  });
  it("批量收衣部分失败保留失败项并明确反馈", async () => {
    const bridge = fakeBridge();
    bridge.take.mockRejectedValueOnce(new Error("模拟失败"));
    dispose = await mountClothesline(bridge);
    fireEvent.click(document.querySelector("#gather")!);
    await waitFor(() => expect(document.querySelector("#toast")?.textContent).toContain("4/5"));
    expect(count()).toBe(1);
    expect(bridge.showPin).toHaveBeenCalledTimes(4);
  });
});

describe("工具条静默态", () => {
  const nav = () => document.querySelector("#ropeToolbar") as HTMLElement;
  const toggle = () => document.querySelector("#toolbarToggle") as HTMLElement;
  it("默认收起，只有一颗把手；悬停展开、移开收起", async () => {
    dispose = await mountClothesline(fakeBridge());
    expect(nav().dataset.open).toBe("false");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.pointerEnter(nav());
    expect(nav().dataset.open).toBe("true");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerLeave(nav());
    await waitFor(() => expect(nav().dataset.open).toBe("false"));
  });
  it("展开态的箭头点一下真的会收起（不是画个箭头就完事）", async () => {
    dispose = await mountClothesline(fakeBridge());
    fireEvent.pointerEnter(nav());
    expect(nav().dataset.open).toBe("true");
    fireEvent.click(toggle());
    expect(nav().dataset.open).toBe("false");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // 再点一次要能重新展开：只朝一个方向生效的按钮同样是「点了没反应」。
    fireEvent.click(toggle());
    expect(nav().dataset.open).toBe("true");
  });
});
