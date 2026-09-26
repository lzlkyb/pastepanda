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
  // jsdom 没有 matchMedia，而内容时序要读系统「减少动态效果」
  // （usePrefersReducedMotion）。这里固定返回 false = 未开启减少动效。
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
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

  it("🔴 展开态清空不再被强制收走：留在列表，用户收起那一刻才走全清（审计修复）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    // 先展开（全清态只发生在「勾完最后一条」的时刻——用户正看着列表）
    fireEvent.click(rootEl(container));
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("list"));
    // 推送 tasks=[]（最后一条被勾掉）
    await act(async () => {
      h.handlers.get("todo-island-update")?.({ payload: { ...STATE, tasks: [] } });
    });
    // 列表不许被抽走：留在 list，给空态
    expect(rootEl(container).getAttribute("data-st")).toBe("list");
    expect(container.textContent).toContain("没有进行中的待办");
    expect(h.invoke).not.toHaveBeenCalledWith("todo_island_hide", { delayMs: 1500 });
    // 用户自己收起 → 此时才按「剩 0 条」走全清 + 延迟隐藏
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(rootEl(container).getAttribute("data-st")).toBe("clear");
    expect(container.textContent).toContain("今天没有待办了");
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("todo_island_hide", { delayMs: 1500 }),
    );
  });

  it("🔴 展开态点外闲置 6s 自动收起（岛窗外点击穿透，没有点外收起就只能手动关）", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container)); // → list
    expect(rootEl(container).getAttribute("data-st")).toBe("list");
    // hover=false（鼠标在别处）挂 6s 计时器；鼠标回来会清理（不在此测）
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
    expect(h.invoke).toHaveBeenCalledWith("todo_island_set_stage", { stage: "pill" });
  });

  it("🔴 compose 有未提交草稿时不自动收起（不能把打了一半的话收没了）", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container)); // → list
    fireEvent.click(screen.getByText("记一条")); // → compose
    fireEvent.change(screen.getByLabelText("记一条待办"), { target: { value: "写一半的事" } });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("compose");
  });

  it("🔴 Rust hide 广播舞台复位 → 前端同步回胶囊（否则下次点亮按旧展开尺寸出现）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    expect(rootEl(container).getAttribute("data-st")).toBe("list");
    await act(async () => {
      h.handlers.get("todo-island-stage-reset")?.({ payload: null });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
  });

  it("收起态下数据被外部清空不切全清（全清是展开时刻的专属语义）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    await act(async () => {
      h.handlers.get("todo-island-update")?.({ payload: { ...STATE, tasks: [] } });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
  });

  it("提醒态：dueAlert 占住胶囊（铃 + 到点了 + 任务文字），点击仍进列表（二期甲案）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    await act(async () => {
      h.handlers
        .get("todo-island-update")
        ?.({ payload: { ...STATE, dueAlert: STATE.tasks[0] } });
    });
    expect(container.textContent).toContain("到点了");
    expect(container.textContent).toContain("交材料");
    // 点了仍展开列表（提醒是事件，不是死胡同）
    fireEvent.click(rootEl(container));
    expect(rootEl(container).getAttribute("data-st")).toBe("list");
  });

  it("peek 显示下一条的**真实**到期时间（B 方案：不编演示时间）", async () => {
    const withDue: IslandState = {
      ...STATE,
      tasks: [{ ...STATE.tasks[0], dueMs: Date.now() + 3_600_000, dueLabel: "今天 16:00" }],
    };
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "todo_island_tasks" ? Promise.resolve(withDue) : Promise.resolve(null),
    );
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    // 胶囊态不多嘴：只有环 + 剩余数 + 下一条
    expect(container.querySelector("[class*='peekDue']")).toBeNull();
    // hover → peek（Rust 轮询广播进来）
    await act(async () => {
      h.handlers.get("todo-island-hover")?.({ payload: true });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("peek");
    expect(container.textContent).toContain("今天 16:00");
    expect(container.querySelector("[class*='peekDue']")).not.toBeNull();
  });

  it("peek 在没有截止时间时不编造时间（宁可少说一句）", async () => {
    // STATE.tasks[0]（交材料）没有 dueMs / dueLabel
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    await act(async () => {
      h.handlers.get("todo-island-hover")?.({ payload: true });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("peek");
    expect(container.querySelector("[class*='peekDue']")).toBeNull();
    expect(container.textContent).toContain("交材料");
  });

  it("提醒态只显示到点那一条的文字，不与下一条待办拼接", async () => {
    const alertTask = STATE.tasks[1]; // 「回邮件给张工」
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "todo_island_tasks"
        ? Promise.resolve({ ...STATE, hint: "交材料", dueAlert: alertTask })
        : Promise.resolve(null),
    );
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    expect(container.textContent).toContain("到点了");
    expect(container.textContent).toContain("回邮件给张工");
    // 胶囊 32px 高只装得下一句话：下一条待办不许跟着拼上来
    expect(container.textContent).not.toContain("交材料");
  });

  it("收起按钮带常驻文字标签（L2：图标 + title 不算标签），快捷键只进 title", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    const btn = screen.getByRole("button", { name: "收起" });
    expect(btn.textContent).toContain("收起");
    expect(btn.getAttribute("title")).toContain("Esc");
  });
  it("勾选：圈先翻面，行 200ms 内退场（另一条不动）", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container)); // → list
    // 等列表显形（折叠层此刻才卸载， global getByText 才不会撞车）
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.getByText("交材料")).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    // 第一拍：圈已经翻面（按钮文案变成「标记为未完成」）
    expect(screen.getAllByTitle("标记为未完成")).toHaveLength(1);
    // 行还在位——得让用户看清刚勾的是哪一条
    expect(screen.getByText("交材料")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.getByText("交材料")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    // 第二拍：行退场，另一条没被牵连
    expect(screen.queryByText("交材料")).toBeNull();
    expect(screen.getByText("回邮件给张工")).toBeTruthy();
  });

  it("勾选失败：退场中的行回到原位，圈也还原", async () => {
    vi.useFakeTimers();
    let rejectToggle!: (reason: Error) => void;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "todo_island_tasks") return Promise.resolve(STATE);
      if (cmd === "todo_island_toggle_task") return new Promise((_, reject) => { rejectToggle = reject; });
      return Promise.resolve(null);
    });
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container));
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("交材料")).toBeNull(); // 已退场
    await act(async () => rejectToggle(new Error("stale task")));
    // 写回失败：乐观翻面作废，行回到列表原位
    expect(screen.getByText("交材料")).toBeTruthy();
    expect(screen.getAllByTitle("完成")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toContain("已还原");
  });
  it("勾选后服务器确认：行进「已完成」，不被退场标记吞掉", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container)); // → list
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    // 服务器确认：这条离开「进行中」、进「已完成」
    await act(async () => {
      h.handlers.get("todo-island-update")?.({
        payload: {
          ...STATE,
          done: 2,
          hint: "回邮件给张工",
          tasks: [STATE.tasks[1]],
          doneTasks: [STATE.tasks[0]],
        },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("交材料")).toBeNull();
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("交材料")).toBeTruthy();
  });});

describe("TodoIslandList 写回", () => {
  it("勾选失败恰逢收起时仍在胶囊显示回滚提示", async () => {
    let rejectToggle!: (reason: Error) => void;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "todo_island_tasks") return Promise.resolve(STATE);
      if (cmd === "todo_island_toggle_task") return new Promise((_, reject) => { rejectToggle = reject; });
      return Promise.resolve(null);
    });
    const { container } = render(<TodoIsland />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(rootEl(container));
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    await act(async () => rejectToggle(new Error("stale task")));
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
    expect(screen.getByRole("alert").textContent).toContain("已还原");
  });
  it("勾选后服务器确认：行进「已完成」，不被退场标记吞掉", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container)); // → list
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    // 服务器确认：这条离开「进行中」、进「已完成」
    await act(async () => {
      h.handlers.get("todo-island-update")?.({
        payload: {
          ...STATE,
          done: 2,
          hint: "回邮件给张工",
          tasks: [STATE.tasks[1]],
          doneTasks: [STATE.tasks[0]],
        },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("交材料")).toBeNull();
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("交材料")).toBeTruthy();
  });
  it("输入失败恰逢收起时仍显示错误，重开输入时保留草稿", async () => {
    let rejectAdd!: (reason: Error) => void;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "todo_island_tasks") return Promise.resolve(STATE);
      if (cmd === "note_append_daily_task") return new Promise((_, reject) => { rejectAdd = reject; });
      return Promise.resolve(null);
    });
    const { container } = render(<TodoIsland />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(rootEl(container));
    fireEvent.click(screen.getByText("记一条"));
    const input = screen.getByLabelText("记一条待办") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "还要处理的事" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => rejectAdd(new Error("write failed")));
    expect(screen.getByRole("alert").textContent).toContain("没记上");
    fireEvent.click(rootEl(container));
    fireEvent.click(screen.getByText("记一条"));
    expect((screen.getByLabelText("记一条待办") as HTMLInputElement).value).toBe("还要处理的事");
  });

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

  it("到期 chip 三态：过期红（前缀已过期）、今天蓝、未来灰；已完成的不再说过期", async () => {
    const now = Date.now();
    const ST: IslandState = {
      ...STATE,
      tasks: [
        { noteId: "n1", noteTitle: "纪要", line: 1, text: "过期任务", done: false, dueMs: now - 86_400_000, dueLabel: "昨天 16:00" },
        { noteId: "n2", noteTitle: "纪要", line: 2, text: "今天任务", done: false, dueMs: now + 3_600_000, dueLabel: "今天 16:00" },
        { noteId: "n3", noteTitle: "纪要", line: 3, text: "未来任务", done: false, dueMs: now + 7 * 86_400_000, dueLabel: "10/2 9:00" },
      ],
      doneTasks: [
        { noteId: "n4", noteTitle: "纪要", line: 4, text: "过期但办完了", done: true, dueMs: now - 86_400_000, dueLabel: "昨天 16:00" },
      ],
    };
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "todo_island_tasks" ? Promise.resolve(ST) : Promise.resolve(null),
    );
    const { container } = render(<TodoIsland />);
    fireEvent.click(await waitFor(() => rootEl(container))); // → list
    const over = screen.getByText("已过期 · 昨天 16:00");
    expect(over.className).toContain("Over");
    const today = screen.getByText("今天 16:00");
    expect(today.className).toContain("Today");
    const future = screen.getByText("10/2 9:00");
    expect(future.className).not.toContain("Over");
    expect(future.className).not.toContain("Today");
    // 已完成 tab：同一到期时刻，不带「已过期」前缀
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("昨天 16:00").className).not.toContain("Over");
  });
});
