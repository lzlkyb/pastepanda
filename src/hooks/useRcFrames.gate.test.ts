/**
 * useRcFrames `enabled` 门守卫单测（2026-09-30，手机端接入引入）。
 *
 * 钉住的不变量：enabled=false 时取帧循环**完全不启动**（零 rc_drain_frames
 * IPC）——这是手机沙盒模式「静态画布不空转泵」的前提；缺省 true，桌面
 * 行为不变。@tauri-apps/api/{event,window} 由 vitest.config 的 alias mock
 * 兜底（listen 永不回调、窗口恒不可见→hook 默认可见）。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRcFrames } from "./useRcFrames";
import { rcDrainFrames } from "@/lib/api/rc";

vi.mock("@/lib/api/rc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 空批：泵跑起来也取不到帧，但「有没有来问」本身就是判据
  rcDrainFrames: vi.fn(async () => new ArrayBuffer(0)),
}));

const canvas = () => document.createElement("canvas");

beforeEach(() => {
  vi.mocked(rcDrainFrames).mockClear();
});

describe("useRcFrames enabled 门", () => {
  it("缺省（桌面路径）：泵启动，立刻开始 drain", async () => {
    const ref = { current: canvas() };
    renderHook(() => useRcFrames("s1", ref));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(rcDrainFrames).toHaveBeenCalled();
  });

  it("enabled=false（手机沙盒）：零 drain 调用", async () => {
    const ref = { current: canvas() };
    renderHook(() => useRcFrames("s1", ref, { enabled: false }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(rcDrainFrames).not.toHaveBeenCalled();
  });

  it("enabled 由 false 翻 true：泵随之启动（换会话接入）", async () => {
    const ref = { current: canvas() };
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useRcFrames("s1", ref, { enabled }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(rcDrainFrames).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(rcDrainFrames).toHaveBeenCalled();
  });
});
