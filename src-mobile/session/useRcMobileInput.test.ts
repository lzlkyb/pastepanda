/**
 * useRcMobileInput 点按路径守卫测试（2026-10-01 真机联调修复）。
 *
 * 钉住的不变量——tap = **先移动再点击**（桌面语义）：
 * 1. sendClick 先发 mouse_move（同坐标、即时不节流），CLICK_HOVER_MS 后才
 *    down/up——远端窗口没收到 mouse_move 就没有悬停过程，hover 菜单等控件
 *    对「无悬停的点击」不响应（用户报「tap 别处鼠标不过去、点击没用」）。
 * 2. 延迟期间已转入按压（pressedButtons 有记录）= 按键被占用，**不补发**
 *    down/up——否则远端收到重复 down 而 up 只配一次，卡键。
 * 3. 右键走同一条路（先移动后点击）。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRcMobileInput } from "./useRcMobileInput";
import { CLICK_HOVER_MS } from "./touchConstants";
import type { RcInputEvent } from "@/lib/api/rcFrameTypes";

const sent = vi.hoisted(() => ({ events: [] as RcInputEvent[] }));

vi.mock("@/lib/api/rcCommands", () => ({
  rcSendInput: (e: RcInputEvent) => {
    sent.events.push(e);
    return Promise.resolve();
  },
}));

/** 画布几何：norm 的映射源（mapNormFromCanvas "fit" 会用到元素 rect）。 */
function canvas() {
  const el = document.createElement("canvas");
  el.width = 1000;
  el.height = 500;
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }) as DOMRect;
  return el;
}

function harness() {
  const ref = { current: canvas() };
  return renderHook(() =>
    useRcMobileInput({
      canControl: true,
      hasFrame: true,
      canvasRef: ref,
      contentRef: { current: { w: 1000, h: 500 } },
    }),
  );
}

/** 推进假定时器并 flush 挂起的微任务（setTimeout 里的 sendEvent 是同步推入）。 */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  sent.events = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRcMobileInput 点按路径", () => {
  it("tap：先即时 mouse_move（同坐标），CLICK_HOVER_MS 后才 down/up", async () => {
    const { result } = harness();
    await act(async () => {
      result.current.sendClick(1, 100, 50);
    });
    // 移动必须**同步先行**（不节流、不延迟）——它是悬停的前提
    expect(sent.events.map((e) => e.kind)).toEqual(["mouse_move"]);
    const mv = sent.events[0];
    if (mv.kind !== "mouse_move") throw new Error("首个事件应为 mouse_move");

    await tick(CLICK_HOVER_MS);

    expect(sent.events.map((e) => e.kind)).toEqual(["mouse_move", "mouse_button", "mouse_button"]);
    const down = sent.events[1];
    const up = sent.events[2];
    if (down.kind !== "mouse_button" || up.kind !== "mouse_button") throw new Error("事件类型不对");
    // 点击坐标与移动坐标一致（归一化后同源）
    expect([down.x, down.y]).toEqual([mv.x, mv.y]);
    expect([up.x, up.y]).toEqual([mv.x, mv.y]);
    expect([down.button, down.down]).toEqual([1, true]);
    expect([up.button, up.down]).toEqual([1, false]);
  });

  it("延迟窗口内已按压（拖拽接管）：不补发 down/up，防卡键", async () => {
    const { result } = harness();
    await act(async () => {
      result.current.sendClick(1, 100, 50);
    });
    // 60ms 内用户手指已经开始拖动：dragDown 先占用左键
    await act(async () => {
      result.current.dragDown(120, 60);
    });
    await tick(CLICK_HOVER_MS + 10);

    // 序列：move（tap 预发）→ button down（dragDown）→ 没有 tap 的补发
    expect(sent.events.map((e) => e.kind)).toEqual(["mouse_move", "mouse_button"]);
    const down = sent.events[1];
    if (down.kind !== "mouse_button") throw new Error("事件类型不对");
    expect(down.down).toBe(true);
  });

  it("右键同路：先移动，延迟后 right down/up", async () => {
    const { result } = harness();
    await act(async () => {
      result.current.sendClick(2, 200, 100);
    });
    expect(sent.events.map((e) => e.kind)).toEqual(["mouse_move"]);
    await tick(CLICK_HOVER_MS);
    expect(sent.events.map((e) => e.kind)).toEqual(["mouse_move", "mouse_button", "mouse_button"]);
    const down = sent.events[1];
    if (down.kind !== "mouse_button") throw new Error("事件类型不对");
    expect(down.button).toBe(2);
    expect(down.down).toBe(true);
  });

  it("无会话门控（hasFrame=false）：零事件——没有画面不发输入", async () => {
    const ref = { current: canvas() };
    const { result } = renderHook(() =>
      useRcMobileInput({
        canControl: true,
        hasFrame: false,
        canvasRef: ref,
        contentRef: { current: { w: 1000, h: 500 } },
      }),
    );
    await act(async () => {
      result.current.sendClick(1, 100, 50);
    });
    await tick(CLICK_HOVER_MS + 10);
    expect(sent.events).toEqual([]);
  });
});

describe("R2 输入取消与权限", () => {
  it("失焦或模式切换释放时取消延迟点击", async () => {
    const { result } = harness();
    act(() => { result.current.sendClick(1, 100, 50); result.current.releaseAll(); });
    await tick(CLICK_HOVER_MS + 10);
    expect(sent.events.map(e => e.kind)).toEqual(["mouse_move"]);
  });
  it("只看模式和等待画面禁止文本、功能键、移动及拖拽", () => {
    for (const state of [{ canControl: false, hasFrame: true }, { canControl: true, hasFrame: false }]) {
      const { result, unmount } = renderHook(() => useRcMobileInput({ ...state, canvasRef: { current: canvas() }, contentRef: { current: { w: 1000, h: 500 } } }));
      act(() => { result.current.sendText("你好"); result.current.sendKeyPair(13); result.current.queueMove(20, 20); result.current.dragDown(20, 20); });
      expect(sent.events).toEqual([]); unmount();
    }
  });
  it("权限撤回取消已排队点击并释放按住的键", async () => {
    const ref = { current: canvas() }, contentRef = { current: { w: 1000, h: 500 } };
    const { result, rerender } = renderHook(({ canControl }) => useRcMobileInput({ canControl, hasFrame: true, canvasRef: ref, contentRef }), { initialProps: { canControl: true } });
    act(() => { result.current.sendKeyDown(17); result.current.sendClick(1, 100, 50); });
    rerender({ canControl: false }); await tick(CLICK_HOVER_MS + 10);
    expect(sent.events.filter(e => e.kind === "mouse_button")).toEqual([]);
    expect(sent.events.filter(e => e.kind === "key")).toEqual([{ kind: "key", vk: 17, down: true }, { kind: "key", vk: 17, down: false }]);
  });
  it("多个小幅滚动累计后产生滚轮事件", () => {
    const { result } = harness();
    act(() => { for (let i = 0; i < 80; i++) result.current.scrollByFrame(0, -1, 50, 50); });
    expect(sent.events.some(e => e.kind === "wheel" && e.delta < 0)).toBe(true);
  });
});
