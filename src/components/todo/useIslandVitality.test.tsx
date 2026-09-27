/**
 * 内容活性三动效守卫单测（活性设计稿 §6④）。
 *
 * 钉住三件事：
 * - useLiveDue：临近走字 / 已过期不脉冲（没观察到正数不算「跨线」）/ 离开清表；
 * - 事件脉冲：新待办触发、**批量灌入不触发**（静默窗）、提醒点火才摇铃、
 *   挂载时已存在的提醒不是事件（基线不响）、全清描画；
 * - reducedMotion：全部短路（信息不变，只去掉运动）。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMmSs, useIslandVitality } from "./useIslandVitality";
import type { IslandState, IslandStage } from "@/lib/todo/types";

function state(partial: Partial<IslandState>): IslandState {
  return {
    total: 1,
    done: 0,
    hint: "",
    tasks: [{ noteId: "n1", noteTitle: "笔记", line: 1, text: "事", done: false }],
    doneTasks: [],
    dueAlert: null,
    ...partial,
  };
}

const base = {
  stage: "peek" as IslandStage,
  reducedMotion: false,
  hover: false,
  intent: false,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("formatMmSs", () => {
  it("毫秒 → mm:ss，负值钳 00:00", () => {
    expect(formatMmSs(892_000)).toBe("14:52");
    expect(formatMmSs(59_000)).toBe("00:59");
    expect(formatMmSs(0)).toBe("00:00");
    expect(formatMmSs(-5_000)).toBe("00:00");
  });
});

describe("动效一：实时递减", () => {
  /** stage=peek + 唯一任务带 dueMs → Hook 内部应激活递减（dueHasTime 显式 true） */
  function withDue(dueMs: number | undefined) {
    return state({
      tasks: [{ ...state({}).tasks[0], dueMs, dueHasTime: true, dueLabel: "今天 16:00" }],
    });
  }

  it("临近走字、每秒更新、跨 0 → 清空并脉冲一次", () => {
    const { result } = renderHook(
      (p: IslandState) => useIslandVitality({ ...base, state: p }),
      { initialProps: withDue(Date.now() + 5_000) },
    );
    expect(result.current.liveDue).toBe("00:05");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.liveDue).toBe("00:03");
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.liveDue).toBeNull();
    expect(result.current.pulsing).toBe(true);
  });

  it("挂载即已过期：不脉冲（没观察到正数不算跨线）", () => {
    const { result } = renderHook(
      (p: IslandState) => useIslandVitality({ ...base, state: p }),
      { initialProps: withDue(Date.now() - 1_000) },
    );
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.liveDue).toBeNull();
    expect(result.current.pulsing).toBe(false);
  });

  it("全天任务（dueHasTime=false）不递减", () => {
    const { result } = renderHook(
      (p: IslandState) => useIslandVitality({ ...base, state: p }),
      {
        initialProps: state({
          tasks: [{ ...state({}).tasks[0], dueMs: Date.now() + 5_000, dueHasTime: false }],
        }),
      },
    );
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.liveDue).toBeNull();
  });
});

describe("动效二：事件脉冲", () => {
  it("新待办到达（静默窗外）→ 脉冲", () => {
    const { result, rerender } = renderHook(
      (p: IslandState) => useIslandVitality({ ...base, state: p }),
      { initialProps: state({}) },
    );
    act(() => {
      vi.advanceTimersByTime(1_500); // 出静默窗
    });
    rerender(state({ tasks: [...state({}).tasks, { ...state({}).tasks[0], line: 2, text: "第二件" }], total: 2 }));
    expect(result.current.pulsing).toBe(true);
  });

  it("静默窗内的批量灌入不脉冲", () => {
    const { result, rerender } = renderHook(
      (p: IslandState) => useIslandVitality({ ...base, state: p }),
      { initialProps: state({}) },
    );
    act(() => {
      vi.advanceTimersByTime(200); // 仍在 1s 静默窗内
    });
    rerender(
      state({ tasks: [1, 2, 3].map((i) => ({ ...state({}).tasks[0], line: i, text: `事${i}` })), total: 3 }),
    );
    expect(result.current.pulsing).toBe(false);
  });

  it("提醒点火 → 脉冲 + 摇铃；挂载时已存在的提醒不是事件", () => {
    // 基线不响
    const mountedWithAlert = renderHook(
      (p: IslandState) => useIslandVitality({ ...base, stage: "pill", state: p }),
      { initialProps: state({ dueAlert: state({}).tasks[0] }) },
    );
    expect(mountedWithAlert.result.current.shaking).toBe(false);
    // 运行中点火才响
    const { result, rerender } = renderHook(
      (p: IslandState) => useIslandVitality({ ...base, state: p }),
      { initialProps: state({}) },
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(state({ dueAlert: state({}).tasks[0] }));
    expect(result.current.pulsing).toBe(true);
    expect(result.current.shaking).toBe(true);
  });

  it("进入 clear → 描画", () => {
    const { result, rerender } = renderHook(
      (p: IslandStage) => useIslandVitality({ ...base, stage: p, state: state({}) }),
      { initialProps: "peek" },
    );
    expect(result.current.drawing).toBe(false);
    rerender("clear");
    expect(result.current.drawing).toBe(true);
  });
});

describe("reducedMotion：全部短路", () => {
  it("新待办到达不脉冲、clear 不描画、跨 0 不脉冲", () => {
    const { result, rerender } = renderHook(
      (p: { state: IslandState; stage: IslandStage }) =>
        useIslandVitality({ ...base, reducedMotion: true, state: p.state, stage: p.stage }),
      { initialProps: { state: state({}), stage: "peek" as IslandStage } },
    );
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    rerender({
      state: state({ tasks: [state({}).tasks[0], { ...state({}).tasks[0], line: 2 }], total: 2 }),
      stage: "peek",
    });
    rerender({ state: state({}), stage: "clear" });
    expect(result.current.pulsing).toBe(false);
    expect(result.current.shaking).toBe(false);
    expect(result.current.drawing).toBe(false);
  });
});
