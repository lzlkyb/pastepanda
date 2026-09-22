/**
 * RcWindowControls 守卫单测（批7，2026-09-22）。
 *
 * 这一段的价值几乎全在最后一条：窗口按钮谁都会写，但「关闭」这一步**必须**走
 * `close()` 而不是 `destroy()`——`useRcWorkbenchClose` 拦的是 `onCloseRequested`，
 * `destroy()` 直接拆窗口、绕过那道「有会话先问」的守卫，现象是「窗口没了、会话还在
 * 对面跑」。这个差别在界面上看不出来（都关掉了），只有断言挡得住。
 *
 * `@tauri-apps/api/window` 整模块覆盖（先例：`src/__tests__/rcWorkbenchClose.test.tsx`）：
 * 共享 mock 只保证「不炸」，这里要断言调用行为，所以自己给一组 spy。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  isMaximized: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  onResized: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: h.minimize,
    toggleMaximize: h.toggleMaximize,
    isMaximized: h.isMaximized,
    close: h.close,
    destroy: h.destroy,
    onResized: h.onResized,
  }),
}));

import { RcCloseButton, RcWindowControls } from "./RcWindowControls";

beforeEach(() => {
  h.minimize.mockReset().mockResolvedValue(undefined);
  h.toggleMaximize.mockReset().mockResolvedValue(undefined);
  h.isMaximized.mockReset().mockResolvedValue(false);
  h.close.mockReset().mockResolvedValue(undefined);
  h.destroy.mockReset().mockResolvedValue(undefined);
  h.onResized.mockReset().mockResolvedValue(() => {});
});

describe("RcWindowControls", () => {
  it("三个按钮都带可读名称（稿子画的是纯图标，没有可见文字）", () => {
    render(<RcWindowControls />);

    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("最小化 / 最大化分别打到对应的窗口 API", () => {
    render(<RcWindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(h.minimize).toHaveBeenCalledTimes(1);
    expect(h.toggleMaximize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(h.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("🔴 关闭走 close()（交给关闭守卫），绝不调 destroy()", () => {
    render(<RcWindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(h.close).toHaveBeenCalledTimes(1);
    // destroy() 会绕过 onCloseRequested，「有会话先问」那道守卫就形同虚设
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("已最大化时那格变成「向下还原」（图标与无障碍名一起换）", async () => {
    h.isMaximized.mockResolvedValue(true);
    render(<RcWindowControls />);

    expect(await screen.findByRole("button", { name: "向下还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });

  it("RcCloseButton 单独用（会话态顶条只补这一枚）也是同一个关闭语义", () => {
    render(<RcCloseButton />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
  });
});
