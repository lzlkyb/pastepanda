/**
 * RcFullscreenHotbar 守卫单测（方案 B，2026-09-24）。
 *
 * 全屏态唯一控制入口：浮现逻辑看不见但致命——热区唤不出 / 指针锁定时假唤出 /
 * 关闭绕过确认，三条都只有断言挡得住。
 *
 * `@tauri-apps/api/window` 整模块覆盖（spy），理由同 `RcWindowControls.test.tsx`。
 */
import { fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { RcFullscreenHotbar } from "./RcFullscreenHotbar";

const base = {
  fit: "fit" as const,
  onFit: vi.fn(),
  pointerLocked: false,
  onTogglePointer: vi.fn(),
  canControl: true,
  onToggleFullscreen: vi.fn(),
  onRequestEnd: vi.fn(),
  busy: false,
  info: "2560×1440 · H.264 · 60fps",
};

beforeEach(() => {
  h.close.mockReset().mockResolvedValue(undefined);
  h.destroy.mockReset().mockResolvedValue(undefined);
  h.minimize.mockReset().mockResolvedValue(undefined);
  h.toggleMaximize.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/** 挂进带尺寸的父级（mousemove 监听挂 parentElement）。 */
function mount(props: Partial<typeof base> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const utils = render(
    <RcFullscreenHotbar {...base} {...props} />,
    { container: host },
  );
  // root = host 的唯一子元素；把它挂回 host 供 parentElement 命中
  return { ...utils, host };
}

describe("RcFullscreenHotbar（方案 B：全屏顶边 hot zone）", () => {
  it("全屏态的全套入口都在：显示组 / 指针锁 / 退出全屏 / 结束会话 / 窗口三键", () => {
    render(<RcFullscreenHotbar {...base} />);

    expect(screen.getByRole("button", { name: "适应" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1:1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "填充" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "锁定指针" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "结束会话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("只看会话不出现指针锁（canControl=false）", () => {
    render(<RcFullscreenHotbar {...base} canControl={false} />);

    expect(screen.queryByRole("button", { name: "锁定指针" })).toBeNull();
  });

  it("结束会话接 onRequestEnd（父级有确认弹窗守卫），busy 时禁用", () => {
    const onRequestEnd = vi.fn();
    const { rerender } = render(<RcFullscreenHotbar {...base} onRequestEnd={onRequestEnd} />);

    fireEvent.click(screen.getByRole("button", { name: "结束会话" }));
    expect(onRequestEnd).toHaveBeenCalledTimes(1);

    rerender(<RcFullscreenHotbar {...base} onRequestEnd={onRequestEnd} busy />);
    expect(
      (screen.getByRole("button", { name: "结束会话" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("关闭走 close()，不绕过「有会话先问」的守卫（红线）", () => {
    render(<RcFullscreenHotbar {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("最小化走 minimize()；最大化走 toggleMaximize()", () => {
    render(<RcFullscreenHotbar {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));

    expect(h.minimize).toHaveBeenCalledTimes(1);
    expect(h.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("无交互 2.5s 后淡出：隐藏态 visibility:hidden 且按钮移出 Tab 环", () => {
    vi.useFakeTimers();
    const { container } = render(<RcFullscreenHotbar {...base} />);

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    const bar = container.firstElementChild as HTMLElement;
    expect(bar.className).toContain("viewToolsHidden");
    // jsdom 不加载 CSS module 的声明，computed visibility 恒为 visible——
    // 那是环境限制不是代码问题；类名（visibility:hidden 在其中）+ aria + tabIndex 已覆盖。
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    // aria-hidden=true 让 role 查询整体隐身（这正是它该干的），改 DOM 直查
    const close = bar.querySelector('button[aria-label="关闭"]') as HTMLButtonElement;
    expect(close).toBeTruthy();
    expect(close.tabIndex).toBe(-1);
  });

  it("指针锁定时顶边 mousemove 不唤出（假光标唤出是假象）", () => {
    vi.useFakeTimers();
    const { container, host } = mount({ pointerLocked: true });
    const bar = container.firstElementChild as HTMLElement;

    act(() => {
      vi.advanceTimersByTime(2500); // 先淡出
    });
    expect(bar.className).toContain("viewToolsHidden");

    // 顶边热区内移动：pointerLocked=true ⇒ 不该唤出
    act(() => {
      const stage = host;
      stage.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 1000, bottom: 800 }) as DOMRect;
      bar.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 1000, bottom: 44 }) as DOMRect;
      fireEvent.mouseMove(stage, { clientX: 500, clientY: 4 });
    });
    expect(bar.className).toContain("viewToolsHidden");
  });

  it("未锁定时顶边 mousemove 唤出（热区 8px 内）", () => {
    vi.useFakeTimers();
    const { container, host } = mount();
    const bar = container.firstElementChild as HTMLElement;

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(bar.className).toContain("viewToolsHidden");

    act(() => {
      const stage = host;
      stage.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 1000, bottom: 800 }) as DOMRect;
      bar.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 1000, bottom: 44 }) as DOMRect;
      fireEvent.mouseMove(stage, { clientX: 500, clientY: 4 });
    });
    expect(bar.className).not.toContain("viewToolsHidden");
  });
});
