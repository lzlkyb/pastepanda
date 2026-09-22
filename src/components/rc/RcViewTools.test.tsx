import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { RcViewTools } from "./RcViewTools";
import styles from "./RemoteComputer.module.css";

/** jsdom 的 getBoundingClientRect 全是 0：画面区/工具条矩形都退化为原点，
 *  clientX/clientY = 0 的 mousemove 恰好同时命中 inStage / nearTop / overBar。 */

function renderTools() {
  return render(
    <RcViewTools
      fit="fit"
      onFit={vi.fn()}
      pointerLocked={false}
      onTogglePointer={vi.fn()}
      canControl={false}
      fullscreen={false}
      onToggleFullscreen={vi.fn()}
    />,
  );
}

/** P2-12：mousemove 挂在画面容器（组件根的 parentElement）上，不再用 window。 */
function moveMouse(stage: HTMLElement, x: number, y: number) {
  act(() => {
    stage.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
  });
}

function stageOf(container: HTMLElement) {
  return container as HTMLElement;
}

function hiddenEl(container: HTMLElement) {
  return container.querySelector(`.${styles.viewToolsHidden}`);
}

function toolButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button"));
}

describe("RcViewTools 浮现式工具条", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("初始可见，2.5s 无交互后淡出隐藏", () => {
    const { container } = renderTools();
    expect(hiddenEl(container)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(hiddenEl(container)).not.toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("隐藏后鼠标回到画面上缘重新唤出", () => {
    const { container } = renderTools();
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(hiddenEl(container)).not.toBeNull();
    moveMouse(stageOf(container), 0, 0);
    expect(hiddenEl(container)).toBeNull();
  });

  it("悬停在工具条上不隐藏（正在去点按钮）", () => {
    const { container } = renderTools();
    moveMouse(stageOf(container), 0, 0); // overBar：清掉隐藏计时
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(hiddenEl(container)).toBeNull();
  });

  it("P2-12：隐藏时按钮 tabIndex=-1，不再进 Tab 环", () => {
    const { container } = renderTools();
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(hiddenEl(container)).not.toBeNull();
    for (const btn of toolButtons(container)) {
      expect(btn.tabIndex).toBe(-1);
    }
  });

  it("P2-12：显示时按钮可 Tab（tabIndex 默认 0）", () => {
    const { container } = renderTools();
    expect(hiddenEl(container)).toBeNull();
    for (const btn of toolButtons(container)) {
      expect(btn.tabIndex).toBe(0);
    }
  });

  it("P2-12：mousemove 只响应画面容器，window 事件不再唤出", () => {
    const { container } = renderTools();
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(hiddenEl(container)).not.toBeNull();
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 0 }));
    });
    expect(hiddenEl(container)).not.toBeNull();
  });
});
