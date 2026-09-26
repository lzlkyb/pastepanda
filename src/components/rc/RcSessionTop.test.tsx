/**
 * RcSessionTop 守卫单测（2026-09-24 浮条收编后重写；2026-09-25 定稿）。
 *
 * 顶栏已瘦身为**纯窗口壳**（灯 / 名字 / 三键）：会话操作（警示 / 结束 / 更多 /
 * 重连）全部搬进 RcSessionCapsule。这里守住三件事：
 * - 拖拽区与 md 全屏编辑器同款：`deep`（整条子树可拖、双击最大化由注入脚本
 *   内置、按钮自动豁免）；全屏态禁拖（="false"）；
 * - 三键逐字打到 Rust 命令出口（lib/rcWindowOps，不经 per-window ACL）；
 * - 瘦身不再回弹——结束会话/警示胶囊出现在顶栏即为回归（会与浮条双中心）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RcSession } from "@/lib/api/rc";

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

import { RcSessionTop } from "./RcSessionTop";
import styles from "./RemoteComputer.module.css";

const SESSION = {
  peer: "peer-a",
  peer_name: "工作电脑",
  capability: "control",
  phase: "outbound_active",
  started_ms: 1_700_000_000_000,
  granted: true,
} as unknown as RcSession;

const base = {
  session: SESSION,
  linkState: "connected" as const,
  fullscreen: false,
};

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.isMaximized.mockReset().mockResolvedValue(false);
  h.onResized.mockReset().mockResolvedValue(() => {});
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("RcSessionTop（md 全屏编辑器同款拖拽区 + 命令三键）", () => {
  it("🔴 顶条挂 deep 拖拽区——与 md 全屏编辑器同款（子树可拖/双击最大化/按钮豁免）", () => {
    const { container } = render(<RcSessionTop {...base} />);

    expect(container.firstElementChild?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("全屏中禁用拖窗（顶条此时是画面顶边，拖拽会牵动窗口）", () => {
    const { container } = render(<RcSessionTop {...base} fullscreen />);

    expect(container.firstElementChild?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("🔴 全屏双组三键：hideWindowControls 隐藏顶条三键（hotbar 右上角已有同语义组）", () => {
    render(<RcSessionTop {...base} fullscreen hideWindowControls />);

    expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("完整三键组：最小化 / 最大化 / 关闭，逐字打到 Rust 命令", () => {
    render(<RcSessionTop {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(h.invoke).toHaveBeenCalledWith("rc_window_minimize");
    expect(h.invoke).toHaveBeenCalledWith("rc_window_close");
  });

  it("名字仍在顶栏（身份的常驻位）；连接灯由 linkState 驱动分三档", () => {
    const { container, rerender } = render(<RcSessionTop {...base} />);
    expect(screen.getByText(/正在查看/)).toBeTruthy();
    expect(container.querySelector(`.${styles.live}`)).not.toBeNull();

    rerender(<RcSessionTop {...base} linkState="unstable" />);
    expect(container.querySelector(`.${styles.liveOff}`)).not.toBeNull();

    rerender(<RcSessionTop {...base} linkState="failed" />);
    expect(container.querySelector(`.${styles.liveBad}`)).not.toBeNull();
  });

  it("🔴 瘦身不再回弹：结束会话 / 更多 / 警示胶囊不得回到顶栏（都在浮条里）", () => {
    const { container } = render(<RcSessionTop {...base} linkState="failed" />);

    expect(screen.queryByRole("button", { name: "结束会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /重连/ })).toBeNull();
    // pillWarn/pillDanger 类已随浮条收编删除——警示文案不得在顶栏出现
    expect(container.textContent).not.toContain("对方版本偏旧");
    expect(container.textContent).not.toContain("已断开");
  });
});
