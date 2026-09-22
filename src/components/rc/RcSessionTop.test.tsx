/**
 * RcSessionTop 守卫单测（批7，2026-09-22）。
 *
 * 会话态整条工作台标题栏被 `hidesWorkbenchTitleBar` 收掉、画面铺满整个窗口。
 * 窗口改 `decorations(false)` 之后那一态**没有系统标题栏**——顶条不兼作拖拽区，
 * 窗口就拖不动；不补关闭键，用户只能去杀进程。两条都在界面上「看不见」，
 * 只有断言挡得住。
 *
 * `@tauri-apps/api/window` 整模块覆盖（spy），理由同 `RcWindowControls.test.tsx`。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RcSession } from "@/lib/api/rc";

const h = vi.hoisted(() => ({ close: vi.fn(), destroy: vi.fn() }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: h.close, destroy: h.destroy }),
}));

import { RcSessionTop } from "./RcSessionTop";

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
  canControl: true,
  kbOn: false,
  linkState: "connected" as const,
  unansweredSec: 0,
  busy: false,
  onReleaseKb: vi.fn(),
  onRequestEnd: vi.fn(),
};

beforeEach(() => {
  h.close.mockReset().mockResolvedValue(undefined);
  h.destroy.mockReset().mockResolvedValue(undefined);
});

describe("RcSessionTop（批7：会话态顶条兼作拖拽区）", () => {
  it("顶条挂 deep 拖拽区——会话态没有标题栏，能拖的只剩这一条", () => {
    const { container } = render(<RcSessionTop {...base} />);

    expect(container.firstElementChild?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("最右补了关闭键：会话态唯一能关掉窗口的地方", () => {
    render(<RcSessionTop {...base} />);

    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("关闭键同样走 close()，不绕过「有会话先问」的守卫", () => {
    render(<RcSessionTop {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("原有的会话操作没被挤掉（顶条还是那条）", () => {
    render(<RcSessionTop {...base} />);

    expect(screen.getByText(/正在查看/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "结束会话" })).toBeTruthy();
  });
});
