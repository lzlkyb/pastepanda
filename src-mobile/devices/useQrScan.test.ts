/**
 * useQrScan 守卫单测 —— 「停下来」的四条路里，切后台这条最容易漏：
 * WebView 里摄像头指示灯不会说谎，停不下来就是隐私事故。钉住
 * 后台停拍 → 回前台续扫 → 用户取消后不续 的不变量。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useQrScan } from "./useQrScan";

const gUM = vi.hoisted(() => ({ mock: vi.fn() }));

vi.mock("jsqr", () => ({ default: () => null }));

function fakeStream() {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } };
}

beforeEach(() => {
  gUM.mock.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: gUM.mock },
  });
  // jsdom 无 2d 上下文：桩一个够拉帧用的最小实现
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("切后台停摄像头，回前台自动续扫", async () => {
  const hidden = vi.spyOn(document, "hidden", "get");
  const { result } = renderHook(() => useQrScan(vi.fn()));
  const first = fakeStream();
  gUM.mock.mockResolvedValue(first.stream);
  await act(async () => { await result.current.start(); });
  expect(result.current.state).toBe("scanning");

  hidden.mockReturnValue(true);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(first.track.stop).toHaveBeenCalledTimes(1);

  hidden.mockReturnValue(false);
  const second = fakeStream();
  gUM.mock.mockResolvedValue(second.stream);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => expect(result.current.state).toBe("scanning"));
  expect(gUM.mock).toHaveBeenCalledTimes(2);
});

it("用户取消后回前台不再续扫", async () => {
  const hidden = vi.spyOn(document, "hidden", "get");
  const { result } = renderHook(() => useQrScan(vi.fn()));
  const first = fakeStream();
  gUM.mock.mockResolvedValue(first.stream);
  await act(async () => { await result.current.start(); });

  act(() => { result.current.stop(); });
  expect(first.track.stop).toHaveBeenCalledTimes(1);

  hidden.mockReturnValue(true);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  hidden.mockReturnValue(false);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(gUM.mock).toHaveBeenCalledTimes(1);
  expect(result.current.state).toBe("scanning");
});
