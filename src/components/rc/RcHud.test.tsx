import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { RcHud } from "./RcHud";
import styles from "./RemoteComputer.module.css";

/** jsdom 无布局：这里只测交互逻辑（悬停/点击展开、点外收起、行条件渲染）。 */

const baseProps = {
  codec: "h264",
  fps: 30,
  rttMs: 12,
  quality: "auto",
  scope: "virtual",
  linkState: "connected" as const,
  pathKind: "lan",
};

function renderHud(extra: Partial<Parameters<typeof RcHud>[0]> = {}) {
  return render(<RcHud {...baseProps} {...extra} />);
}

function panel(container: HTMLElement) {
  return container.querySelector(`.${styles.hudPanel}`);
}

describe("RcHud 状态明细面板", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("初始只有 chip 条，没有面板", () => {
    const { container } = renderHud();
    expect(panel(container)).toBeNull();
    expect(container.querySelector(`.${styles.hud}`)).not.toBeNull();
  });

  it("点击 chip 条展开明细；再点收起", () => {
    const { container } = renderHud({ respMs: 24 });
    const hud = container.querySelector(`.${styles.hud}`)!;
    fireEvent.click(hud);
    expect(panel(container)).not.toBeNull();
    expect(hud.getAttribute("aria-expanded")).toBe("true");
    // 数据驱动的行：有样本的格才有行
    expect(panel(container)!.textContent).toContain("操作");
    fireEvent.click(hud);
    expect(panel(container)).toBeNull();
  });

  it("悬停 300ms 展开，移出 250ms 收起（chip → 面板的空隙不会闪关）", () => {
    const { container } = renderHud();
    const wrap = container.firstElementChild!;
    act(() => {
      fireEvent.mouseEnter(wrap);
      vi.advanceTimersByTime(299);
    });
    expect(panel(container)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(panel(container)).not.toBeNull();
    act(() => {
      fireEvent.mouseLeave(wrap);
      vi.advanceTimersByTime(249);
    });
    expect(panel(container)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(panel(container)).toBeNull();
  });

  it("打开时点外面（画面上）收起", () => {
    const { container } = renderHud();
    act(() => {
      fireEvent.mouseEnter(container.firstElementChild!);
      vi.advanceTimersByTime(300);
    });
    expect(panel(container)).not.toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(panel(container)).toBeNull();
  });

  it("无样本的格不出行：最小 props 下只有基础四行", () => {
    const { container } = renderHud({ rttMs: 0, pathKind: "" });
    fireEvent.click(container.querySelector(`.${styles.hud}`)!);
    const text = panel(container)!.textContent ?? "";
    for (const label of ["编码", "画质", "画面", "链路"]) {
      expect(text).toContain(label);
    }
    for (const label of ["往返", "画面龄", "分段", "操作", "丢包", "码率", "路径"]) {
      expect(text).not.toContain(label);
    }
  });
});
