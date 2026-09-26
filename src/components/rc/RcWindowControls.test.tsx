/**
 * RcWindowControls 守卫单测（批7，2026-09-22；方案A 2026-09-25 改命令出口）。
 *
 * 这一段的价值几乎全在最后一条：窗口按钮谁都会写，但「关闭」这一步**必须**走
 * `close` 语义（rc_window_close，与 JS close() 同一条运行时路径，触发
 * CloseRequested）而不是 destroy——`useRcWorkbenchClose` 拦的是 onCloseRequested，
 * destroy 直接拆窗口、绕过那道「有会话先问」的守卫，现象是「窗口没了、会话还在
 * 对面跑」。这个差别在界面上看不出来，只有断言挡得住。
 *
 * `@tauri-apps/api/core` 的 invoke 打桩（方案A 后三键全走 Rust 命令，见
 * lib/rcWindowOps）；`@tauri-apps/api/window` 仍要给 useMaximized 的
 * isMaximized/onResized 一组 spy。vitest 环境没有 `__TAURI_INTERNALS__`，
 * rcWindowOps 会判「非 Tauri」短路——用例里补上再清掉。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: h.isMaximized,
    onResized: h.onResized,
  }),
}));

import { RcCloseButton, RcWindowControls } from "./RcWindowControls";

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.isMaximized.mockReset().mockResolvedValue(false);
  h.onResized.mockReset().mockResolvedValue(() => {});
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("RcWindowControls", () => {
  it("三个按钮都带可读名称（稿子画的是纯图标，没有可见文字）", () => {
    render(<RcWindowControls />);

    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("最小化 / 最大化分别打到对应的 Rust 命令", () => {
    render(<RcWindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(h.invoke).toHaveBeenNthCalledWith(1, "rc_window_minimize");

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(h.invoke).toHaveBeenNthCalledWith(2, "rc_window_toggle_maximize");
  });

  it("🔴 关闭走 rc_window_close（交给关闭守卫），绝不出现 destroy", () => {
    render(<RcWindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(h.invoke).toHaveBeenNthCalledWith(1, "rc_window_close");
    // 这组按钮只许打三键命令集——任何别的窗口操作（如 destroy 绕守卫）都是回归
    const allCmds = h.invoke.mock.calls.map((c) => c[0]);
    expect(allCmds.every((c) => typeof c === "string" && c.startsWith("rc_window_"))).toBe(true);
  });

  it("已最大化时那格变成「向下还原」（图标与无障碍名一起换）", async () => {
    h.isMaximized.mockResolvedValue(true);
    render(<RcWindowControls />);

    expect(await screen.findByRole("button", { name: "向下还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });

  it("RcCloseButton 单独用也是同一个关闭语义", () => {
    render(<RcCloseButton />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(h.invoke).toHaveBeenCalledWith("rc_window_close");
  });
});
