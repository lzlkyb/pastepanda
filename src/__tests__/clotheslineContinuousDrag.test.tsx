import { beforeEach, describe, expect, it, vi } from "vitest";
import { installGestures } from "../clothesline/gestures.mjs";

function setup() {
  document.body.innerHTML = '<div id="stage"><div id="hangs"><div class="hang" data-id="a"></div></div><div id="left"></div><div id="right"></div><div id="mover"></div><div id="marker"></div><div id="hint"></div></div>';
  const el = (id: string) => document.getElementById(id)!;
  const card = document.querySelector(".hang") as HTMLElement;
  card.style.left = "300px"; card.style.top = "100px";
  card.setPointerCapture = vi.fn(); card.hasPointerCapture = vi.fn(() => true); card.releasePointerCapture = vi.fn();
  const onDetach = vi.fn(), onReorder = vi.fn(), onPreview = vi.fn(), onError = vi.fn();
  const curve = Array(65).fill(0);
  const gestures = installGestures({
    stage: el("stage"), hangs: el("hangs"), left: el("left"), right: el("right"), mover: el("mover"),
    marker: el("marker"), hint: el("hint"),
    getState: () => ({ locked: false, width: 1000, height: 800, clearingIds: new Set(), pendingHangs: new Set(), pins: [], anchors: { left: {x:100,y:100},right:{x:700,y:100} } }),
    getGeometry: () => ({ left: 100, right: 700, span: 600, queued: 0, cards: [{item:{id:"a", aspect: 1}, x:300, width:100, height:100, iw:100, ih:100}], anchors:{left:{x:100,y:100},right:{x:700,y:100}} }),
    getCurve: () => curve, onAnchors: vi.fn(), onAnchorCommit: vi.fn(),
    onDetach, onReorder, onPreview, onError, onInteraction: vi.fn(), onFinish: vi.fn(), onGeometryCancel: vi.fn(), onSlotPreview: vi.fn(),
  });
  const event = (x: number, y: number, pointerId = 1) => ({ button: 0, pointerId, clientX: x, clientY: y, target: card } as unknown as PointerEvent);
  const hangs = el("hangs");
  return { card, hangs, gestures, onDetach, onReorder, onPreview, onError, curve,
    down: () => hangs.onpointerdown!(event(300,100)),
    move: (x: number,y: number) => hangs.onpointermove!(event(x,y)),
    up: (x=300,y=100,pointerId=1) => hangs.onpointerup!(event(x,y,pointerId)) };
}
beforeEach(() => { document.body.innerHTML = ""; });
describe("从绳上连续拖入应用", () => {
  it("准备期间绳形改变不能把停住的按住手势误判成主动拉回", () => {
    const s = setup(); s.down(); s.move(320, 180);
    s.curve.fill(100); s.move(320, 180);
    expect(s.gestures.isDragging()).toBe(true);
    expect(s.onDetach.mock.calls[0][4].release().cancelled).toBe(false);
  });
  it("其它指针的松手、取消和移动不能结束当前按住的拖拽", () => {
    const s=setup();s.down();s.move(320,180);
    const foreign={pointerId:2,clientX:500,clientY:500,target:s.card} as unknown as PointerEvent;
    s.hangs.onpointermove!(foreign);s.hangs.onpointercancel!(foreign);s.up(500,500,2);
    expect(s.gestures.isDragging()).toBe(true);
    expect(s.onDetach.mock.calls[0][4].release()).toEqual({held:true,cancelled:false,point:{x:320,y:180}});
  });
  it("旧元素的捕获丢失事件不能取消新照片的手势", () => {
    const s=setup();s.down();s.move(320,180);
    s.hangs.onlostpointercapture!({pointerId:1,target:document.createElement('div')} as unknown as PointerEvent);
    expect(s.gestures.isDragging()).toBe(true);
    s.hangs.onlostpointercapture!({pointerId:1,target:s.card} as unknown as PointerEvent);
    expect(s.gestures.isDragging()).toBe(false);
  });
  it("快速拉离时按松手的最终位置取下，不能误开预览", () => {
    const s=setup();s.down();s.up(320,180);
    expect(s.onDetach).toHaveBeenCalledOnce();expect(s.onPreview).not.toHaveBeenCalled();
    expect(s.onDetach.mock.calls[0][4].release()).toEqual({held:false,cancelled:false,point:{x:320,y:180}});
  });
  it("准备期间最后一帧松回绳带必须取消取下", () => {
    const s=setup();s.down();s.move(320,180);s.up(300,100);
    expect(s.onDetach.mock.calls[0][4].release().cancelled).toBe(true);
  });
  it("捕获失败后提示并复位，下一次拖动可以重试", () => {
    const s=setup();vi.mocked(s.card.setPointerCapture).mockImplementationOnce(()=>{throw new Error('pointer ended');});
    expect(()=>s.down()).not.toThrow();expect(s.gestures.isDragging()).toBe(false);
    expect(s.onError).toHaveBeenCalledOnce();s.down();expect(s.gestures.isDragging()).toBe(true);
  });
  it("拉离立即准备，确认后才释放捕获，松手不重复取下", () => {
    const s = setup(); s.down(); s.move(320,180);
    expect(s.onDetach).toHaveBeenCalledWith("a", s.card, true, true, expect.any(Object));
    expect(s.gestures.isDragging()).toBe(true);
    expect(s.card.releasePointerCapture).not.toHaveBeenCalled();
    const handoff = s.onDetach.mock.calls[0][4];
    expect(handoff.release()).toEqual({ held: true, cancelled: false, point: { x: 320, y: 180 } });
    expect(s.gestures.isDragging()).toBe(false);
    expect(s.card.releasePointerCapture).toHaveBeenCalledOnce();
    s.up(); expect(s.onDetach).toHaveBeenCalledOnce();
  });
  it("绳带内移动仍排序，单击仍预览", () => {
    const s = setup(); s.down(); s.move(340,100);
    expect(s.onDetach).not.toHaveBeenCalled(); s.up(); expect(s.onReorder).toHaveBeenCalledOnce();
    s.down(); s.up(); expect(s.onPreview).toHaveBeenCalledWith("a");
  });
  it("尚未脱离时取消，不能创建贴图或交付", () => {
    const s = setup(); s.down(); s.move(320,110); s.gestures.cancelDrag(); s.up();
    expect(s.onDetach).not.toHaveBeenCalled();
    expect(s.onReorder).not.toHaveBeenCalled();
  });
});
