// @vitest-environment jsdom
// 拖拽入口守卫：驱动真实的 installGestures，而不是读源码字符串。
// 2026-10-23 审查发现：02ac0f35 把「一张在途锁整根绳」收窄成按 id，只改了
// runtime.mjs 的按钮 disabled，gestures.mjs 的 pointerdown 入口还是全局锁 ——
// 卡片拖不动、端点把手亮着却按不动，且不弹任何提示。旧守卫只 readFileSync
// runtime.mjs，所以全绿。这里改成真的发一次 pointerdown，从行为上钉住。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { installGestures } from "../clothesline/gestures.mjs";

const ANCHORS = { left: { x: 100, y: 100 }, right: { x: 700, y: 100 } };
// anchors 不能漏：ropePoint 的 y = 锚点线 + curve 偏移，缺了它拖到落点会直接抛错。
const GEOMETRY = { cards: [], left: 100, right: 700, span: 600, anchors: ANCHORS };

type State = {
  nativeReceiving: boolean;
  clearing: boolean;
  collecting: boolean;
  pendingHangs: Set<string>;
  taking: Set<string>;
  pins: { item: { id: string }; pending?: boolean; pendingBack?: boolean }[];
  locked: boolean;
  clearingIds: Set<string>;
  anchors: typeof ANCHORS;
  custom: boolean;
  width: number;
  height: number;
};

function mount(overrides: Partial<State> = {}, extra: { coach?: () => boolean } = {}) {
  document.body.innerHTML = `
    <div id="stage"></div>
    <div id="hangs"><div class="hang" data-id="a"><div class="frame"></div></div><div class="hang" data-id="b"><div class="frame"></div></div></div>
    <button id="left"></button><button id="right"></button>
    <button id="mover"></button><div id="marker"></div><div id="hint"></div>`;
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const state: State = {
    nativeReceiving: false,
    clearing: false,
    collecting: false,
    pendingHangs: new Set(),
    taking: new Set(),
    pins: [],
    locked: false,
    clearingIds: new Set(),
    anchors: ANCHORS,
    custom: false,
    width: 800,
    height: 600,
    ...overrides,
  };
  const started: boolean[] = [];
  const errors: unknown[] = [];
  const gestures = installGestures({
    stage: $("stage"),
    hangs: $("hangs"),
    left: $("left"),
    right: $("right"),
    mover: $("mover"),
    marker: $("marker"),
    hint: $("hint"),
    getState: () => state,
    getGeometry: () => GEOMETRY as never,
    getCurve: () => new Array(65).fill(100),
    onAnchors: () => {},
    onAnchorCommit: () => {},
    onDetach: () => {},
    onTransferEnd: () => {},
    onReorder: () => {},
    onPreview: () => {},
    onInteraction: (active: boolean) => { started.push(active); },
    onFinish: () => {},
    onGeometryCancel: () => {},
    onSlotPreview: () => undefined,
    onError: (error: unknown) => errors.push(error),
    coach: extra.coach,
  } as any);
  const press = (el: Element) => {
    const event = new MouseEvent("pointerdown", { bubbles: true, clientX: 120, clientY: 110, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    el.dispatchEvent(event);
  };
  const move = (el: Element, clientX: number, clientY: number) => {
    const event = new MouseEvent("pointermove", { bubbles: true, clientX, clientY });
    Object.defineProperty(event, "pointerId", { value: 1 });
    el.dispatchEvent(event);
  };
  return { gestures, state, $, started, errors, press, move };
}

beforeEach(() => {
  // jsdom 不实现指针捕获；缺了会被 begin 的 try/catch 当成「拖动未开始」。
  Object.assign(Element.prototype, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  });
});

describe("拖拽入口只锁「这一张」，不锁整根绳", () => {
  it("没有在途状态时，卡片与端点都能起拖（对照）", () => {
    const { started, $, press, gestures } = mount();
    press($("hangs").querySelectorAll(".hang")[1]);
    gestures.cancelDrag();
    press($("left"));
    expect(started.filter(Boolean)).toHaveLength(2);
  });

  it("另一张图正在取下时，第二张卡片仍然能拖", () => {
    const { started, $, press } = mount({ taking: new Set(["a"]) });
    press($("hangs").querySelectorAll(".hang")[1]);
    expect(started).toContain(true);
  });

  it("另一张图正在取下时，端点把手仍然能拖", () => {
    const { started, $, press } = mount({ taking: new Set(["a"]) });
    press($("left"));
    expect(started).toContain(true);
  });

  it("另一张贴图正在挂回时，整绳把手仍然能拖", () => {
    const { started, $, press } = mount({ pendingHangs: new Set(["a"]) });
    press($("mover"));
    expect(started).toContain(true);
  });

  it("同一张图在取下时，它自己不能起拖（按 id 仍然要挡）", () => {
    const { started, $, press } = mount({ taking: new Set(["a"]) });
    press($("hangs").querySelectorAll(".hang")[0]);
    expect(started).toEqual([]);
  });

  it("锁定位置时端点与整绳都不能拖（这条是全局的，必须保留）", () => {
    const { started, $, press } = mount({ locked: true });
    press($("left"));
    press($("mover"));
    expect(started).toEqual([]);
  });

  it("大风吹走期间端点与卡片都不能拖", () => {
    const { started, $, press } = mount({ clearing: true, clearingIds: new Set(["a"]) });
    press($("left"));
    press($("hangs").querySelectorAll(".hang")[1]);
    expect(started).toEqual([]);
  });
});

describe("不再引用已删除的撤销状态", () => {
  it("gestures 源码里不能再出现 state.undoing", async () => {
    // 撤销条在 02ac0f35 整段删除，state 上已无 undoing 字段；
    // 留着它就是一条恒 false 的死条件，还会让读代码的人以为撤销仍在。
    const fs = await import("node:fs/promises");
    const source = await fs.readFile("src/clothesline/gestures.mjs", "utf8");
    expect(source).not.toContain("state.undoing");
    const types = await fs.readFile("src/clothesline/gestures.d.mts", "utf8");
    expect(types).not.toContain("undoing");
  });
});

describe("拖拽教学只在前三次真正拖动时出现", () => {
  it("单击照片（不移动）不消耗教学次数", () => {
    // begin() 在 pointerdown 就会跑，松手不移是「打开预览」。
    // 如果在那里扣计数，点三次照片就再也看不到教学了。
    const coach = vi.fn(() => true);
    const { $, press, gestures } = mount({}, { coach });
    press($("hangs").querySelectorAll(".hang")[1]);
    gestures.cancelDrag();
    press($("hangs").querySelectorAll(".hang")[0]);
    gestures.cancelDrag();
    expect(coach).not.toHaveBeenCalled();
  });

  it("拖到落点时才判定一次，且文案跟着判定结果显隐", () => {
    const shown = vi.fn(() => true);
    const on = mount({}, { coach: shown });
    on.press(on.$("hangs").querySelectorAll(".hang")[1]);
    // 绳线 y = 锚点 100 + curve 偏移 100 = 200，落点带是 ±36。
    // 起手 (120,110) → (200,290) 让拖动中心落在 (80,180)，处于带内 ⇒ 会显示幽灵位。
    on.move(on.$("hangs"), 200, 290);
    on.move(on.$("hangs"), 220, 295);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(on.$("hint").hidden).toBe(false);

    const off = mount({}, { coach: () => false });
    off.press(off.$("hangs").querySelectorAll(".hang")[1]);
    off.move(off.$("hangs"), 200, 290);
    expect(off.$("hint").hidden).toBe(true);
  });
});
