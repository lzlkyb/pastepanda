/**
 * 预览窗壳的守卫（2026-10-18）：
 * ① 三键各自只发对应的窗口操作，最大化态换图标与可访问名；
 * ② 帧率读不出时两枚逐帧键必须真的不可用（不是「点了没反应」）。
 *
 * ② 是这条改动的核心承诺之一：拿 1/30 兜底会让人以为步进是精确的，
 * 所以宁可置灰。这个断言在去掉 `disabled={!fps}` 后会立刻变红。
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { PreviewChrome } from "./RecPreviewChrome";
import { PreviewPlayer } from "./RecPreviewPlayer";
import type { useRecPlayback } from "./useRecPlayback";

afterEach(cleanup);

const chrome = (maximized: boolean, onOp = vi.fn()) => {
  render(
    <PreviewChrome
      name="录屏 2026-10-18.mp4"
      bytes={18_432_000}
      durationMs={26_700}
      resolution="1920×1080"
      fps={30}
      maximized={maximized}
      closeLabel="关闭预览"
      onOp={onOp}
    />,
  );
  return onOp;
};

const playback = (step = vi.fn()) =>
  ({
    videoRef: { current: null },
    playing: false,
    currentMs: 0,
    metaMs: 0,
    resolution: null,
    rate: 1,
    volume: 1,
    muted: false,
    loop: false,
    blocked: null,
    clearBlocked: () => {},
    events: {},
    seek: () => {},
    toggle: () => {},
    step,
    cycleRate: () => {},
    setVolume: () => {},
    toggleMute: () => {},
    toggleLoop: () => {},
  }) as unknown as ReturnType<typeof useRecPlayback>;

describe("preview window chrome", () => {
  it("routes each of the three buttons to its own window op", () => {
    const onOp = chrome(false);
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onOp.mock.calls.map(([op]) => op)).toEqual(["minimize", "toggle-max", "close"]);
  });

  it("names the toggle by what it will do, not by the window state", () => {
    chrome(true);
    expect(screen.getByRole("button", { name: "向下还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });

  it("prints the facts the old header never showed", () => {
    chrome(false);
    const meta = document.querySelector(".rec-pv-meta")?.textContent ?? "";
    expect(meta).toContain("1920×1080");
    expect(meta).toContain("30 fps");
    expect(meta).toContain("17.6 MB");
  });
});

describe("frame stepping", () => {
  it("greys both frame buttons out when the frame rate is unknown", () => {
    const step = vi.fn();
    render(<PreviewPlayer src="/a.mp4" durationMs={10_000} fps={null} playback={playback(step)} />);
    for (const name of ["上一帧", "下一帧"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(step).not.toHaveBeenCalled();
  });

  it("steps by the real frame rate when it is known", () => {
    const step = vi.fn();
    render(<PreviewPlayer src="/a.mp4" durationMs={10_000} fps={30} playback={playback(step)} />);
    fireEvent.click(screen.getByRole("button", { name: "下一帧" }));
    fireEvent.click(screen.getByRole("button", { name: "上一帧" }));
    expect(step.mock.calls).toEqual([
      [1, 30],
      [-1, 30],
    ]);
  });
});
