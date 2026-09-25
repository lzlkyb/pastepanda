/**
 * 待办灵动岛守卫单测（展开批，2026-09-24）。
 *
 * jsdom 无布局，这里只钉**交互与几何的约定**：
 * - 点胶囊 → `set_stage("list")` 立即发出（长大：先切窗口）；
 * - Esc 两级取消：输入态先回列表、再回胶囊（规则 17.6）；
 * - 勾选必须走 `todo_island_toggle_task`（行号 + 原文一起带去，防漂移）；
 * - 「记一条」回车 → `note_append_daily_task`；
 * - 全清：进行中清空 → 舞台切 clear。
 *
 * Tauri API 整模块 mock（先例：RcWindowControls.test.tsx）。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IslandState } from "@/lib/todo/types";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return Promise.resolve(() => h.handlers.delete(name));
  },
}));

import { TodoIsland } from "./TodoIsland";

const STATE: IslandState = {
  total: 4,
  done: 1,
  hint: "交材料",
  tasks: [
    { noteId: "n1", noteTitle: "今日速记", line: 3, text: "交材料", done: false },
    { noteId: "n2", noteTitle: "会议纪要", line: 7, text: "回邮件给张工", done: false },
  ],
  doneTasks: [{ noteId: "n1", noteTitle: "今日速记", line: 1, text: "已办的事", done: true }],
};

function rootEl(container: HTMLElement) {
  return container.firstElementChild as HTMLElement;
}

beforeEach(() => {
  h.handlers.clear();
  h.invoke.mockReset();
  // 拉快照的默认实现；每条用例可再覆盖
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "todo_island_tasks") return Promise.resolve(STATE);
    return Promise.resolve(null);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TodoIsland 舞台机", () => {
  it("收起态渲染真数据：剩余数与下一条", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("交材料");
  });

  it("点胶囊 → list 舞台，窗口几何立即交给 Rust 动画（2026-09-25 起尺寸动画在窗口侧）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container));
    expect(rootEl(container).getAttribute("data-st")).toBe("list");
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("todo_island_set_stage", { stage: "list" }),
    );
  });

  it("Esc 两级取消：输入态先回列表，再 Esc 才回胶囊（规则 17.6）", async () => {
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    // pill → list
    fireEvent.click(rootEl(container));
    // list → compose（点底栏「记一条」）
    fireEvent.click(screen.getByText("记一条"));
    expect(rootEl(container).getAttribute("data-st")).toBe("compose");
    expect(h.invoke).toHaveBeenCalledWith("todo_island_set_stage", { stage: "compose" });
    // 第一次 Esc：compose → list（缩放动画同在窗口侧，set_stage 与舞台切换同刻发出）
    h.invoke.mockClear(); // 清掉 grow 阶段的调用记录，只看 Esc 之后的行为
    fireEvent.keyDown(window, { key: "Escape" });
    expect(rootEl(container).getAttribute("data-st")).toBe("list");
    expect(h.invoke).toHaveBeenCalledWith("todo_island_set_stage", { stage: "list" });
    // 第二次 Esc：list → pill
    fireEvent.keyDown(window, { key: "Escape" });
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
  });

  it("全清：展开态下进行中清空 → 舞台切 clear，并请求延迟隐藏", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    // 先展开（全清态只发生在「勾完最后一条」的时刻——用户正看着列表）
    fireEvent.click(rootEl(container));
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("list"));
    // 推送 tasks=[]（最后一条被勾掉）
    await act(async () => {
      h.handlers.get("todo-island-update")?.({ payload: { ...STATE, tasks: [] } });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("clear");
    expect(container.textContent).toContain("今天没有待办了");
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("todo_island_hide", { delayMs: 1500 }),
    );
  });

  it("收起态下数据被外部清空不切全清（全清是展开时刻的专属语义）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    await act(async () => {
      h.handlers.get("todo-island-update")?.({ payload: { ...STATE, tasks: [] } });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
  });
});

describe("TodoIslandList 写回", () => {
  it("勾选必须带 noteId + line + 原文走 toggle_task（行号漂移防线）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("todo_island_toggle_task", {
        noteId: "n1",
        line: 3,
        expectedText: "交材料",
      }),
    );
  });

  it("「记一条」回车 → note_append_daily_task，成功后清空输入", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    fireEvent.click(screen.getByText("记一条")); // → compose
    const input = screen.getByLabelText("记一条待办") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "给绿萝浇水" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("note_append_daily_task", { text: "给绿萝浇水" }),
    );
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("「已完成」标签页展示已勾任务", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container));
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("已办的事")).toBeTruthy();
  });
});
