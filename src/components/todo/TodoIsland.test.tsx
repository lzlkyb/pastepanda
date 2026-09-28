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
    expect(h.invoke).not.toHaveBeenCalledWith("todo_island_hide", { delayMs: 2500 });
    // 用户自己收起 → 此时才按「剩 0 条」走全清 + 延迟隐藏
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(rootEl(container).getAttribute("data-st")).toBe("clear");
    expect(container.textContent).toContain("今天没有待办了");
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("todo_island_hide", { delayMs: 2500 }),
    );
  });

  it("🔴 tab 挂岛层：收起再展开仍在原视图，不被重置回「进行中」（critique P2-3，规则 §15.2）", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("已办的事")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起" })); // 收起（列表卸载）
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // 再展开
    // 还在「已完成」：已办的事直接可见，没有被甩回「进行中」
    expect(screen.getByText("已办的事")).toBeTruthy();
  });

  it("🔴 语义层跟得上视觉层（audit 2026-09-28 P2/P3）：胶囊标签报剩余数、alert 常驻、tab 关联面板", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    // 剩余数只画在环和数字上（纯视觉）——读屏用户展开前也得知道「还剩几件」
    expect(rootEl(container).getAttribute("aria-label")).toContain("还剩 3 项待办");
    // 失败提示的播报口在收起态就已挂载：条件挂载的 role 节点第一次来不及播报
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(rootEl(container)); // → list
    expect(document.getElementById("island-tabpanel")?.getAttribute("role")).toBe("tabpanel");
    expect(document.getElementById("island-tab-open")?.getAttribute("aria-controls")).toBe("island-tabpanel");
    expect(document.getElementById("island-tab-done")?.getAttribute("aria-controls")).toBe("island-tabpanel");
    // 面板里的行仍在真 list 里（tabpanel 与 list 分两层，不能一个 div 兼两个角色）
    expect(document.querySelector("#island-tabpanel [role='list']")).toBeTruthy();
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

  it("记一条 快捷条：点选挂时间、提交拼 @ 尾巴、与 @ 尾巴收口（快捷条设计稿）", async () => {
    const added: Array<[string, { text: string }]> = [];
    h.invoke.mockImplementation((cmd: string, args?: { text: string }) => {
      if (cmd === "todo_island_tasks") return Promise.resolve(STATE);
      if (cmd === "note_append_daily_task") {
        added.push([cmd, args as { text: string }]);
        return Promise.resolve(null);
      }
      if (cmd === "todo_island_parse_due")
        return Promise.resolve({ ok: true, label: "明天 14:00", hasTime: true });
      return Promise.resolve(null);
    });
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    fireEvent.click(screen.getByText("记一条")); // → compose
    const input = screen.getByLabelText("记一条待办") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "交报告" } });
    // 快捷条常驻（主路径「点，不用打」）
    expect(container.querySelector("[class*='qbar']")).not.toBeNull();
    // 点「明天」+「14:00」→ 输入行尾小片出现，输入文本一个字符都不被插入
    fireEvent.click(screen.getByRole("button", { name: "明天" }));
    fireEvent.click(screen.getByRole("button", { name: "14:00" }));
    expect(input.value).toBe("交报告");
    expect(container.querySelector("[class*='duetag']")?.textContent).toContain("明天 14:00");
    // 预览条不出现（时间来源已收口到快捷条，文本无 @ 尾巴）
    expect(container.querySelector("[class*='prow']")).toBeNull();
    // 回车 → 提交的是拼好 @ 尾巴的文本，走同一条 Rust due_tail 解析链
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(added).toEqual([["note_append_daily_task", { text: "交报告 @明天 14:00" }]]));
    // 创建后快捷条自动复位（连续记多条不串味）
    expect(container.querySelector("[class*='duetag']")).toBeNull();
    // 没选日期直接点时刻 → 默认挂今天（一步到位）
    fireEvent.click(screen.getByRole("button", { name: "18:00" }));
    expect(container.querySelector("[class*='duetag']")?.textContent).toContain("今天 18:00");
    fireEvent.change(input, { target: { value: "买牛奶 @" } }); // 打 @ → 快捷条选择清空（收口不变量）
    expect(container.querySelector("[class*='duetag']")).toBeNull();
    // 面板已退役：Esc 直接走两级取消（compose → list）
    fireEvent.keyDown(input, { key: "Escape" });
    expect(rootEl(container).getAttribute("data-st")).toBe("list");
  });

  it("peek 显示下一条的**真实**到期时间（B 方案：不编演示时间）", async () => {
    // dueMs 取 2h 外：递减视野是 <1h（活性设计稿 §1），卡 1h 边界会被走字接管、测不到静态文案
    const withDue: IslandState = {
      ...STATE,
      tasks: [{ ...STATE.tasks[0], dueMs: Date.now() + 7_200_000, dueLabel: "今天 16:00" }],
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

  it("意图态接线（吸附双态设计稿 §3）：intent=true 只点亮 glow、不切舞台；离开熄灭；展开态不点亮", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    // 停留 3 拍：intent 事件先于 hover 事件到——glow 预告点亮，舞台**仍**是胶囊
    await act(async () => {
      h.handlers.get("todo-island-intent")?.({ payload: true });
    });
    expect(rootEl(container).getAttribute("data-intent")).toBe("1");
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
    // 光标离开：Rust 补发 false，glow 熄灭
    await act(async () => {
      h.handlers.get("todo-island-intent")?.({ payload: false });
    });
    expect(rootEl(container).getAttribute("data-intent")).toBeNull();
    // 展开态不点亮：光标本来就在岛上，glow 由 data-hover 负责，intent 不掺和
    fireEvent.click(rootEl(container)); // → list
    await act(async () => {
      h.handlers.get("todo-island-intent")?.({ payload: true });
    });
    expect(rootEl(container).getAttribute("data-intent")).toBeNull();
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
  it("🔴 整行可点 = 勾选（B 方案）：点行文字与点来源名都触发一次 toggle，点勾圈不双重触发", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    h.invoke.mockClear(); // 清掉 mount 拉快照与切舞台的调用，只看勾选行为
    // hint 与行文字都叫「交材料」：只点列表行那个（.tx）
    const rowText = screen
      .getAllByText("交材料")
      .find((el) => el.className.includes("tx")) as HTMLElement;
    fireEvent.click(rowText); // 点行文字
    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    expect(h.invoke).toHaveBeenCalledWith("todo_island_toggle_task", {
      noteId: "n1",
      line: 3,
      expectedText: "交材料",
    });
    h.invoke.mockClear();
    // 点来源笔记名：参与整行勾选（critique 2026-09-28 P3——「打开笔记」还没实现，
    // 拦下冒泡只会变成点了没反应的一格，与 B 方案「整行可点」冲突）
    fireEvent.click(screen.getByText("今日速记"));
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("todo_island_toggle_task", {
      noteId: "n1",
      line: 3,
      expectedText: "交材料",
    });
    // 点勾圈本体：只发一次（stopPropagation 拦住行上的第二次）
    h.invoke.mockClear();
    fireEvent.click(screen.getAllByRole("button", { name: /完成|标记为未完成/ })[0]);
    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
  });

  it("勾选进入 6s 完成态驻留：行留原位 + 撤销 chip，到点才退场（另一条不动）", async () => {
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
    // 光标在岛上（刚点完勾）：hover=true 挂起闲置自收，测试只聚焦驻留逻辑
    await act(async () => {
      h.handlers.get("todo-island-hover")?.({ payload: true });
    });
    expect(screen.getByText("交材料")).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    // 第一拍：圈已经翻面（按钮文案变成「标记为未完成」），行还在原位
    expect(screen.getAllByTitle("标记为未完成")).toHaveLength(1);
    expect(screen.getByText("交材料")).toBeTruthy();
    // 行尾出现「撤销」chip；写回在点击瞬间已发出（驻留只是视觉窗口）
    expect(screen.getByText("撤销")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.invoke).toHaveBeenCalledWith("todo_island_toggle_task", {
      noteId: "n1",
      line: 3,
      expectedText: "交材料",
    });
    // 服务器确认归档（真实流程推送很快到）：行改由驻留快照续命
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
    // 6s 驻留到点 → 退场动画 200ms 内仍渲染，放完才摘；另一条没被牵连
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByText("交材料")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("交材料")).toBeNull();
    expect(screen.getByText("回邮件给张工")).toBeTruthy();
  });

  it("驻留中点「撤销」：再发一次 toggle 回未完成，倒计时作废（6s 后行还在）", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container));
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // 光标在岛上（刚点完勾）：hover=true 挂起闲置自收
    await act(async () => {
      h.handlers.get("todo-island-hover")?.({ payload: true });
    });
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    await act(async () => {
      await Promise.resolve();
    });
    h.invoke.mockClear();
    fireEvent.click(screen.getByText("撤销"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.invoke).toHaveBeenCalledWith("todo_island_toggle_task", {
      noteId: "n1",
      line: 3,
      expectedText: "交材料",
    });
    // 行回未完成态，chip 与倒计时随之消失
    expect(screen.getByText("交材料")).toBeTruthy();
    expect(screen.getAllByTitle("完成")).toHaveLength(2);
    expect(screen.queryByText("撤销")).toBeNull();
    // 倒计时已作废：远超 6s 行也不退场
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("交材料")).toBeTruthy();
  });

  it("悬停驻留行暂停倒计时，移开恢复（设计稿 S2）", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container));
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // 光标在岛上（刚点完勾）：hover=true 挂起闲置自收
    await act(async () => {
      h.handlers.get("todo-island-hover")?.({ payload: true });
    });
    fireEvent.click(screen.getAllByTitle("完成")[0]);
    const rowEl = screen.getByText("交材料").closest("[role='listitem']") as HTMLElement;
    // 服务器确认归档（真实流程）：行改由驻留快照续命
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
    // 悬停该行 → 计时挂起：远超 6s 也不退场
    fireEvent.mouseEnter(rowEl);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("交材料")).toBeTruthy();
    // 移开 → 从剩余时间恢复：6s 后退场动画放完，行摘除
    fireEvent.mouseLeave(rowEl);
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("交材料")).toBeNull();
  });

  it("勾选失败：驻留中的行回到原位，圈也还原，chip 消失", async () => {
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
    expect(screen.getByText("交材料")).toBeTruthy(); // 驻留中（不再 200ms 就退场）
    await act(async () => rejectToggle(new Error("stale task")));
    // 写回失败：乐观翻面作废，行回到列表原位的未完成态，chip 随驻留取消消失
    expect(screen.getByText("交材料")).toBeTruthy();
    expect(screen.getAllByTitle("完成")).toHaveLength(2);
    expect(screen.queryByText("撤销")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("已还原");
  });

  it("勾选后服务器确认：行仍驻留原位（不因推送跳没），6s 后才进「已完成」", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container)); // → list
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // 光标在岛上（刚点完勾）：hover=true 挂起闲置自收
    await act(async () => {
      h.handlers.get("todo-island-hover")?.({ payload: true });
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
    // 推送到了也不许跳没：驻留快照续命渲染
    expect(screen.getByText("交材料")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("交材料")).toBeNull();
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("交材料")).toBeTruthy();
  });

  it("🔴 root 键盘可达（P1-1）：tabIndex + Enter/Space 展开，Esc 收回不变", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    const root = rootEl(container);
    expect(root.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(root, { key: "Enter" });
    expect(root.getAttribute("data-st")).toBe("list");
    fireEvent.keyDown(root, { key: "Escape" });
    expect(root.getAttribute("data-st")).toBe("pill");
  });

  it("🔴 全局热键（P1-1）：收起态触发 → 唤岛直进 compose 并请求焦点；再按 → 收回胶囊", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    await act(async () => {
      h.handlers.get("todo-island-hotkey")?.({ payload: null });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("compose");
    expect(h.invoke).toHaveBeenCalledWith("todo_island_focus");
    // 开关键：展开态再按 = 收回胶囊，不抢焦点
    h.invoke.mockClear();
    await act(async () => {
      h.handlers.get("todo-island-hotkey")?.({ payload: null });
    });
    expect(rootEl(container).getAttribute("data-st")).toBe("pill");
    expect(h.invoke).not.toHaveBeenCalledWith("todo_island_focus");
  });

  it("🔴 seg 是真 tab 按钮（P1-1）：←/→ 切换视图且焦点跟到新选中的 tab", async () => {
    const { container } = render(<TodoIsland />);
    await waitFor(() => expect(rootEl(container).getAttribute("data-st")).toBe("pill"));
    fireEvent.click(rootEl(container)); // → list
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByRole("tab", { name: "已完成" }).getAttribute("aria-selected")).toBe("true");
    const tablist = screen.getByRole("tablist", { name: "待办视图" });
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "进行中" }).getAttribute("aria-selected")).toBe("true");
    // roving tabindex：焦点移到新选中的 tab（读屏与键盘用户跟得上）
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "进行中" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "已完成" }).getAttribute("tabindex")).toBe("-1");
  });
});

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
  it("勾选后服务器确认（收起重开路径）：驻留结束才进「已完成」，不被旧标记吞掉", async () => {
    vi.useFakeTimers();
    const { container } = render(<TodoIsland />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(rootEl(container)); // → list
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // 光标在岛上（刚点完勾）：hover=true 挂起闲置自收
    await act(async () => {
      h.handlers.get("todo-island-hover")?.({ payload: true });
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
    // 驻留期（6s 内）：快照续命，「进行中」里仍看得见
    expect(screen.getByText("交材料")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
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
