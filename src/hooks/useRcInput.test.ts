import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { mapNormFromCanvas, useRcInput } from "@/hooks/useRcInput";

vi.mock("@/lib/api/rc", () => ({ rcSendInput: vi.fn(async () => {}) }));
import { rcSendInput } from "@/lib/api/rc";
const mockedSend = vi.mocked(rcSendInput);

function fakeCanvas(rect: { left: number; top: number; width: number; height: number }) {
  return {
    getBoundingClientRect: () => ({ ...rect, right: 0, bottom: 0, x: 0, y: 0 }),
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

describe("mapNormFromCanvas", () => {
  it("fit(contain)：letterbox 中心对齐", () => {
    // 画布 200×100，内容 1:1 → scale=1，居中 ox=50
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const mid = mapNormFromCanvas({ clientX: 100, clientY: 50 }, el, 100, 100, "fit");
    expect(mid.x).toBeGreaterThanOrEqual(32767);
    expect(mid.x).toBeLessThanOrEqual(32768);
    expect(mid.y).toBeGreaterThanOrEqual(32767);
    expect(mid.y).toBeLessThanOrEqual(32768);
  });

  it("fill(cover)：溢出裁切时点击中心仍映射到中心", () => {
    // 画布 200×100，内容 1:1 → cover scale=1，同样居中
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const mid = mapNormFromCanvas({ clientX: 100, clientY: 50 }, el, 100, 100, "fill");
    expect(mid.x).toBeGreaterThanOrEqual(32767);
    expect(mid.x).toBeLessThanOrEqual(32768);
    expect(mid.y).toBeGreaterThanOrEqual(32767);
    expect(mid.y).toBeLessThanOrEqual(32768);
  });

  it("fill：宽内容被裁切时，画布右缘点击对应内容更靠右", () => {
    // 画布 200×100，内容 100×100 → cover scale=2，显示宽 200，ox=0
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const left = mapNormFromCanvas({ clientX: 0, clientY: 50 }, el, 100, 100, "fill");
    const right = mapNormFromCanvas({ clientX: 199, clientY: 50 }, el, 100, 100, "fill");
    expect(left.x).toBe(0);
    expect(right.x).toBeGreaterThan(60000);
  });

  it("fit：窄内容有左右留边时，留边外点击被 clamp", () => {
    // 画布 200×100，内容 100×100 → contain scale=1，ox=50
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const outside = mapNormFromCanvas({ clientX: 10, clientY: 50 }, el, 100, 100, "fit");
    expect(outside.x).toBe(0);
  });
});

/** 渲染完整 hook（canControl + hasFrame），键盘要先 setKbOn(true)。 */
function renderInput() {
  const canvasRef = { current: fakeCanvas({ left: 0, top: 0, width: 100, height: 100 }) };
  const screenRef = { current: document.createElement("div") };
  return renderHook(() =>
    useRcInput({
      canControl: true,
      hasFrame: true,
      contentRef: { current: { w: 100, h: 100 } },
      canvasRef: canvasRef as unknown as React.RefObject<HTMLCanvasElement | null>,
      screenRef: screenRef as unknown as React.RefObject<HTMLDivElement | null>,
      onConfirmEnd: vi.fn(),
    }),
  );
}

/** 伪 KeyboardEvent：keyToVk 只看 code/key，额外带上 esc 守卫要的字段。 */
function keyEv(code: string, key: string, repeat = false) {
  return {
    code,
    key,
    repeat,
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.KeyboardEvent;
}

describe("useRcInput 指令状态与节流", () => {
  beforeEach(() => {
    mockedSend.mockClear();
  });

  it("鼠标侧键（DOM 3/4）被忽略，不再变成左键点远端", () => {
    const { result } = renderInput();
    act(() => result.current.sendButton({ clientX: 1, clientY: 1, button: 3 }, true));
    act(() => result.current.sendButton({ clientX: 1, clientY: 1, button: 4 }, true));
    const mouseCalls = mockedSend.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "mouse_button",
    );
    expect(mouseCalls).toHaveLength(0);
  });

  it("自动重复（按住键连发 keydown）只转发第一条", () => {
    const { result } = renderInput();
    act(() => result.current.setKbOn(true));
    act(() => result.current.onKeyDown(keyEv("KeyW", "w")));
    act(() => result.current.onKeyDown(keyEv("KeyW", "w", true)));
    act(() => result.current.onKeyDown(keyEv("KeyW", "w", true)));
    const downs = mockedSend.mock.calls.filter(
      (c) => (c[0] as { kind: string; down: boolean }).kind === "key" && (c[0] as { down: boolean }).down,
    );
    expect(downs).toHaveLength(1);
    // 松开清档后可以再按
    act(() => result.current.onKeyUp(keyEv("KeyW", "w")));
    act(() => result.current.onKeyDown(keyEv("KeyW", "w")));
    expect(mockedSend).toHaveBeenCalledTimes(3);
  });

  it("releaseTracked 补发全部按下的键与鼠标键", () => {
    const { result } = renderInput();
    act(() => result.current.setKbOn(true));
    act(() => result.current.onKeyDown(keyEv("KeyW", "w")));
    act(() => result.current.sendButton({ clientX: 50, clientY: 50, button: 0 }, true));
    act(() => result.current.releaseTracked());
    expect(mockedSend).toHaveBeenCalledWith({ kind: "key", vk: 0x57, down: false });
    expect(mockedSend).toHaveBeenCalledWith({
      kind: "mouse_button",
      x: 0,
      y: 0,
      button: 1,
      down: false,
    });
  });

  it("window blur 补发按下态（按住 W 切出去不能卡死远端）", () => {
    const { result } = renderInput();
    act(() => result.current.setKbOn(true));
    act(() => result.current.onKeyDown(keyEv("KeyW", "w")));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(mockedSend).toHaveBeenCalledWith({ kind: "key", vk: 0x57, down: false });
  });

  it("滚轮 16ms 内合并为一条，delta 累加坐标取最新", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderInput();
      act(() => result.current.sendWheel(10, 10, -120));
      expect(mockedSend).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(10);
        result.current.sendWheel(20, 20, -120);
      });
      expect(mockedSend).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(5);
        result.current.sendWheel(30, 30, 120);
      });
      expect(mockedSend).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(mockedSend).toHaveBeenCalledTimes(2);
      // -120 + 120 = 0：同窗内混合方向正确抵消（净滚动为零）
      expect(mockedSend).toHaveBeenLastCalledWith({ kind: "wheel", x: 30, y: 30, delta: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
