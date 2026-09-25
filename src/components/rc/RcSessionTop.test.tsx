/**
 * RcSessionTop 守卫单测（2026-09-24 浮条收编后重写）。
 *
 * 顶栏已瘦身为**纯窗口壳**（灯 / 名字 / 三键）：会话操作（警示 / 结束 / 更多 /
 * 重连）全部搬进 RcSessionCapsule。这里守住两件事：
 * - 窗口壳职责一个不少（拖拽区 + 三键，`decorations(false)` 后没有系统标题栏）；
 * - 瘦身不再回弹——结束会话/警示胶囊出现在顶栏即为回归（会与浮条双中心）。
 *
 * `@tauri-apps/api/window` 整模块覆盖（spy），理由同 `RcWindowControls.test.tsx`。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RcSession } from "@/lib/api/rc";

const h = vi.hoisted(() => ({
  close: vi.fn(),
  destroy: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: h.close,
    destroy: h.destroy,
    minimize: h.minimize,
    toggleMaximize: h.toggleMaximize,
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
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
  h.close.mockReset().mockResolvedValue(undefined);
  h.destroy.mockReset().mockResolvedValue(undefined);
  h.minimize.mockReset().mockResolvedValue(undefined);
  h.toggleMaximize.mockReset().mockResolvedValue(undefined);
});

describe("RcSessionTop（浮条收编后：纯窗口壳）", () => {
  it("顶条挂 deep 拖拽区——会话态没有标题栏，能拖的只剩这一条", () => {
    const { container } = render(<RcSessionTop {...base} />);

    expect(container.firstElementChild?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("全屏中禁用拖窗（顶条此时是画面顶边，拖拽会牵动窗口）", () => {
    const { container } = render(<RcSessionTop {...base} fullscreen />);

    expect(container.firstElementChild?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("完整三键组：最小化 / 最大化 / 关闭，渲染不触发窗口操作", () => {
    render(<RcSessionTop {...base} />);

    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(h.minimize).not.toHaveBeenCalled();
  });

  it("最小化走 minimize()；关闭走 close() 不 destroy（「有会话先问」守卫不变）", () => {
    render(<RcSessionTop {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(h.minimize).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
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
