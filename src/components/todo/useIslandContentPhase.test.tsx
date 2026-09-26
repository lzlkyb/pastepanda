import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIslandContentPhase } from "./useIslandContentPhase";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useIslandContentPhase", () => {
  it("展开时先退折叠内容，等窗口开始长大后才显出列表", () => {
    const { result, rerender } = renderHook(
      ({ stage }) => useIslandContentPhase(stage, false),
      { initialProps: { stage: "pill" as "pill" | "list" } },
    );
    expect(result.current.collapsed.visible).toBe(true);
    rerender({ stage: "list" });
    expect(result.current.collapsed.visible).toBe(false);
    expect(result.current.expanded.mounted).toBe(true);
    expect(result.current.expanded.visible).toBe(false);
    expect(result.current.expanded.interactive).toBe(false);
    act(() => vi.advanceTimersByTime(114));
    expect(result.current.expanded.visible).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.expanded.visible).toBe(true);
    expect(result.current.expanded.interactive).toBe(true);
  });

  it("收起时列表先退出，退场完成后才卸载", () => {
    const { result, rerender } = renderHook(
      ({ stage }) => useIslandContentPhase(stage, false),
      { initialProps: { stage: "list" as "pill" | "list" } },
    );
    rerender({ stage: "pill" });
    expect(result.current.expanded.mounted).toBe(true);
    expect(result.current.expanded.visible).toBe(false);
    expect(result.current.collapsed.visible).toBe(false);
    act(() => vi.advanceTimersByTime(115));
    expect(result.current.collapsed.visible).toBe(true);
    act(() => vi.advanceTimersByTime(85));
    expect(result.current.expanded.mounted).toBe(false);
  });

  it("快速反向时旧计时器不能覆盖最后目标", () => {
    const { result, rerender } = renderHook(
      ({ stage }) => useIslandContentPhase(stage, false),
      { initialProps: { stage: "pill" as "pill" | "list" } },
    );
    rerender({ stage: "list" });
    act(() => vi.advanceTimersByTime(50));
    rerender({ stage: "pill" });
    act(() => vi.advanceTimersByTime(50));
    rerender({ stage: "list" });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.expanded).toEqual({ mounted: true, visible: true, interactive: true });
    expect(result.current.collapsed.mounted).toBe(false);
  });

  it("减少动态效果时直接切换，偏好中途改变也不留旧延时", () => {
    const { result, rerender } = renderHook(
      ({ stage, reduced }) => useIslandContentPhase(stage, reduced),
      { initialProps: { stage: "pill" as "pill" | "list", reduced: false } },
    );
    rerender({ stage: "list", reduced: false });
    rerender({ stage: "list", reduced: true });
    expect(result.current.expanded).toEqual({ mounted: true, visible: true, interactive: true });
    expect(result.current.collapsed.mounted).toBe(false);
    rerender({ stage: "pill", reduced: true });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.collapsed).toEqual({ mounted: true, visible: true, interactive: true });
    expect(result.current.expanded.mounted).toBe(false);
  });
});
