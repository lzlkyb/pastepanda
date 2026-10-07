/**
 * RecControlBar 行为测试（四期批1：体积显示 + 暂停键）。
 *
 * 钉两件事：
 * 1. 体积列：rec_status 轮询回来的 bytes 用 lib/utils 的 formatBytes 展示
 *    （`12.3 MB`），0 时不渲染占位——防止首秒闪一个 "0 B"。
 * 2. 暂停键：乐观置位 + rec_pause 传参形状（标量 paused 平传）；点击后按钮
 *    立即换「继续」（失败回滚由 .catch 做，这里钉成功路径与传参）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));

import { RecControlBar } from "./RecControlBar";

function okStatus(bytes: number) {
  return { recording: true, finalizing: false, paused: false, path: "x", elapsedMs: 0, bytes, quality: "high" };
}

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.listen.mockReset().mockResolvedValue(() => {});
  vi.useFakeTimers();
});

describe("RecControlBar：体积列与暂停键", () => {
  it("rec_status.bytes 走 formatBytes 展示，0 时不渲染", async () => {
    h.invoke.mockImplementation((_cmd: string) => {
      return Promise.resolve(okStatus(12_897_481));
    });
    const { queryByText } = render(
      <RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={false} />,
    );
    // 首帧（还没轮询到）：无体积占位
    expect(queryByText(/MB/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // advanceTimersByTimeAsync 已冲刷微任务：轮询的 .then 里 setState 完成，直接断言
    expect(queryByText("12.3 MB")).not.toBeNull();
    vi.useRealTimers();
  });

  it("点暂停 → rec_pause 收到 { paused: true }，按钮换「继续」", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "rec_status") return Promise.resolve(okStatus(0));
      return Promise.resolve(undefined);
    });
    const { getByText } = render(
      <RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={false} />,
    );
    const pause = getByText("暂停");
    await act(async () => {
      fireEvent.click(pause);
    });
    expect(h.invoke).toHaveBeenCalledWith("rec_pause", { paused: true });
    expect(getByText("继续")).not.toBeNull();
    vi.useRealTimers();
  });
});
