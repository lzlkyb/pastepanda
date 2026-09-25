import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { RcHud } from "./RcHud";
import styles from "./RemoteComputer.module.css";

/** jsdom 无布局：这里只测交互逻辑（点击开合、点外收起、行条件渲染）。 */

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

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(`.${styles.capBtn}`);
}

describe("RcHud 连接详情入口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("常驻只有一枚 i 图标按钮，没有面板（遥测不再铺在画面上）", () => {
    const { container } = renderHud();
    const btn = trigger(container);
    expect(btn).not.toBeNull();
    // 2026-09-24 浮条收编：入口从「Info + 连接详情」文字按钮缩成纯图标（可达性靠 aria-label）
    expect(btn!.getAttribute("aria-label")).toBe("连接详情");
    expect(panel(container)).toBeNull();
    // 常驻 DOM = wrapper + 按钮两个盒子。chip 格子（原来最多 10 格）已收编，
    // 这是「不常驻铺陈」的守卫：以后想再往画面常驻区塞信息，这条会挡住。
    expect(container.firstElementChild!.children.length).toBe(1);
  });

  it("点击入口展开明细；再点收起", () => {
    const { container } = renderHud({ respMs: 24 });
    const btn = trigger(container)!;
    fireEvent.click(btn);
    expect(panel(container)).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    // 数据驱动的行：有样本的格才有行
    expect(panel(container)!.textContent).toContain("操作");
    fireEvent.click(btn);
    expect(panel(container)).toBeNull();
  });

  it("鼠标掠过不弹面板（旧的 hover 自动展开已去掉）", () => {
    const { container } = renderHud();
    act(() => {
      fireEvent.mouseEnter(container.firstElementChild!);
      vi.advanceTimersByTime(2000);
    });
    expect(panel(container)).toBeNull();
  });

  it("打开时点外面（画面上）收起", () => {
    const { container } = renderHud();
    fireEvent.click(trigger(container)!);
    expect(panel(container)).not.toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(panel(container)).toBeNull();
  });

  it("无样本的格不出行：最小 props 下只有基础四行", () => {
    const { container } = renderHud({ rttMs: 0, pathKind: "" });
    fireEvent.click(trigger(container)!);
    const text = panel(container)!.textContent ?? "";
    for (const label of ["编码", "画质", "画面", "链路"]) {
      expect(text).toContain(label);
    }
    for (const label of ["分辨率", "往返", "画面龄", "分段", "操作", "丢包", "码率", "路径"]) {
      expect(text).not.toContain(label);
    }
  });

  it("有画面尺寸时补出「分辨率」行（稿里有、原来缺的那条）", () => {
    const { container } = renderHud({ frameSize: { w: 2560, h: 1440 } });
    fireEvent.click(trigger(container)!);
    expect(panel(container)!.textContent).toContain("2560×1440");
  });
});
