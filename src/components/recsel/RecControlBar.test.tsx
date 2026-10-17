/**
 * RecControlBar 行为测试（四期批1：体积显示 + 暂停键）。
 *
 * 钉两件事：
 * 1. 体积放进更多，主条不占空间；仍用统一 formatBytes 显示。
 * 2. 暂停命令确认后换「继续」，传参保持标量 paused。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));

import { RecControlBar } from "./RecControlBar";
import { installResizeObserver } from "@/test-helpers/resizeObserver";

// RecControlBar 挂载即构造 ResizeObserver（尺寸 effect），jsdom 没有这个全局——不装桩
// 开局就抛。刻意**不**装进共享 test-setup.dom.ts：那会让所有 jsdom 测试里
// `typeof ResizeObserver === "undefined"` 的守卫翻转分支（手机端 KnowledgeList、
// useSheetDrag 都靠这条守卫在 jsdom 里活命），2026-10-16 全局装过一次，满载下
// KnowledgeView.test.tsx 随机判红，已收口到用到的文件。
installResizeObserver();

function okStatus(bytes: number) {
  return { recording: true, finalizing: false, paused: false, path: "x", elapsedMs: 0, bytes, quality: "high" };
}

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.listen.mockReset().mockResolvedValue(() => {});
  vi.useFakeTimers();
});

describe("RecControlBar：体积列与暂停键", () => {
  it("rec_status.bytes 在更多详情走 formatBytes 展示", async () => {
    h.invoke.mockImplementation((_cmd: string) => {
      return Promise.resolve(okStatus(12_897_481));
    });
    const { queryByText, getByRole } = render(
      <RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={false} />,
    );
    // 首帧（还没轮询到）：无体积占位
    expect(queryByText(/MB/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // advanceTimersByTimeAsync 已冲刷微任务：轮询的 .then 里 setState 完成，直接断言
    expect(queryByText(/12.3 MB/)).toBeNull();
    // 2026-10-16：「更多」改成图标按钮（§5.2 删掉与按钮同义的文字），按可及名找
    fireEvent.click(getByRole("button", { name: "更多" }));
    expect(queryByText(/12.3 MB/)).not.toBeNull();
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
    await act(async () => {});
    await act(async () => {
      fireEvent.click(pause);
    });
    expect(h.invoke).toHaveBeenCalledWith("rec_pause", { paused: true });
    expect(getByText("继续")).not.toBeNull();
    vi.useRealTimers();
  });
});
