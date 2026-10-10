/**
 * 录屏五期 甲案守卫（2026-10-10 设计稿 §1/§2/§3）。
 *
 * 钉三条「改后」不变量，全部是**行为**断言，不钉源码形状：
 * ① 预览态就有终点（「开始录制」+ Enter 加速器）——改前红在这条按钮根本不存在；
 * ② 🔴 终点必须录「刚悬停过的那扇窗」，**即使鼠标是为了点按钮而移进玻璃条**
 *    （`useRecSelectMouse.ts` 那句 `closest(".rec-glass") ? null` 会让读数在按下前
 *    最后一刻退回整屏 = 用户要录窗口、成片全桌，且画面一切正常）；
 * ③ 画质/音源收进 ⋯ 后，结果必须留在条上当徽标（规则 15.1 同可见性域），
 *    且浮层开着时 Esc 先关浮层（§18 两级取消，不能一步退出选屏）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

const api = vi.hoisted(() => ({
  recGetScreen: vi.fn(),
  recStart: vi.fn(),
  recReady: vi.fn(),
  recCloseWindows: vi.fn(),
  recTakeRerecord: vi.fn(),
}));

vi.mock("@/lib/api/rec", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api/rec");
  return {
    ...actual,
    recGetScreen: api.recGetScreen,
    recStart: api.recStart,
    recReady: api.recReady,
    recCloseWindows: api.recCloseWindows,
    recTakeRerecord: api.recTakeRerecord,
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFocus: () => Promise.resolve(),
    setIgnoreCursorEvents: () => Promise.resolve(),
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { RecSelectOverlay } from "@/components/recsel/RecSelectOverlay";

/** 1280×720 虚拟屏，dpr=1（jsdom 默认）⇒ CSS 像素与物理像素同值，断言里不用换算。 */
const SCREEN = { originX: 0, originY: 0, width: 1280, height: 720 };
/** 一扇可吸附窗口（物理=本地 CSS 坐标）；光标 (350,150) 落在它里面。 */
const WIN = { x: 300, y: 100, w: 400, h: 300 };
/**
 * 铺满整屏的背景大窗：真实桌面上「屏底居中的预览条」多半就压在这样一扇窗上
 * （最大化窗口是常态，不是边角情况）。它排在 `WIN` 后面 ⇒ 只有光标不在 `WIN` 里时才命中。
 */
const WIN_BG = { x: 0, y: 0, w: 1280, h: 720 };

async function mount(windows: { x: number; y: number; w: number; h: number }[] = [WIN]) {
  api.recGetScreen.mockResolvedValue(SCREEN);
  api.recStart.mockResolvedValue(undefined);
  api.recReady.mockResolvedValue(undefined);
  api.recCloseWindows.mockResolvedValue(undefined);
  api.recTakeRerecord.mockResolvedValue(null);
  vi.mocked(invoke).mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "enum_window_rects" ? windows : undefined),
  );
  const utils = render(<RecSelectOverlay config={null} />);
  await act(async () => {}); // 冲刷 recGetScreen / enum_window_rects 的 .then
  return utils;
}

const startBtn = (q: ReturnType<typeof render>) =>
  q.getByRole("button", { name: /开始录制/ });

/**
 * 鼠标事件必须派在**覆盖层根 div 之内**的元素上：React 的事件监听挂在根容器上，
 * 从 `document.body` 派发的只会向上冒泡（body→html→document），根本不经过那层 div，
 * 处理器一次都不会跑（2026-10-10 写这版守卫时踩过，差点把「红」造在错误原因上）。
 */
const root = (q: ReturnType<typeof render>) => q.container.firstElementChild as HTMLElement;

/**
 * 走完倒计时（3 秒）让 rec_start 真正被调；倒计时本身不是本守卫的关注点。
 * 🔴 必须**一次一格**地推进：倒计时是「setState → effect 里再挂一个 setTimeout」的
 * 自链，一次 `advanceTimersByTimeAsync(3100)` 只在 React 重渲染前消费掉第一个定时器，
 * 后面新挂的不在本次时间窗内（实测 3 秒后读数停在「2」，rec_start 零调用）。
 */
async function runCountdown() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("甲案① 预览态就摆终点", () => {
  it("预览态（未做任何点击）条上就有「开始录制」", async () => {
    const q = await mount();
    expect(startBtn(q)).toBeTruthy();
  });

  it("预览态按 Enter = 进倒计时（键盘只做加速器，不必先做一次歧义点击）", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    expect(q.getByText("3")).toBeTruthy();
    expect(api.recStart).not.toHaveBeenCalled(); // 倒计时没走完就不许开录
    await runCountdown();
    expect(api.recStart).toHaveBeenCalledWith(
      expect.objectContaining({ x: 0, y: 0, w: 1280, h: 720 }),
    );
  });

  it("没悬停任何窗口时点「开始录制」= 录整屏", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.recStart).toHaveBeenCalledWith(
      expect.objectContaining({ x: 0, y: 0, w: 1280, h: 720 }),
    );
  });
});

describe("甲案③ 终点不许把悬停目标弄丢（玻璃条上的移动不改变目标）", () => {
  it("悬停窗口 → 鼠标移进玻璃条点「开始录制」→ 录的是那扇窗，不是整屏", async () => {
    const q = await mount();
    // 悬停窗口（目标成立，蓝框亮）
    await act(async () => {
      fireEvent.mouseMove(root(q), { clientX: 350, clientY: 150 });
    });
    // 为了点按钮把鼠标移到「开始录制」上：它在 .rec-glass 里。
    // 🔴 这条**不带**坐标 ⇒ 走的是「条下恰好是窗外」的分支，只钉住规则的一半；
    //    另一半（条下压着另一扇窗）由下一条带坐标的那条钉。两条缺一，规则就不成立。
    await act(async () => {
      fireEvent.mouseMove(startBtn(q));
    });
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.recStart).toHaveBeenCalledWith(
      expect.objectContaining({ x: 300, y: 100, w: 400, h: 300 }),
    );
  });

  it("🔴 玻璃条压在另一扇窗上时也不许换目标（真实桌面：屏底那条多半压着最大化窗）", async () => {
    const q = await mount([WIN, WIN_BG]);
    await act(async () => {
      fireEvent.mouseMove(root(q), { clientX: 350, clientY: 150 });
    });
    expect(q.getByText(/将录制：窗口 400×300/)).toBeTruthy();
    // 带坐标的这次派发才是常态：(700,660) 在 WIN 外、在背景大窗内 ⇒ 命中判定给的是 WIN_BG。
    // 改前的 `hit === null && closest(".rec-glass")` 只挡 null 分支，这里目标会当场变成整屏。
    await act(async () => {
      fireEvent.mouseMove(startBtn(q), { clientX: 700, clientY: 660 });
    });
    expect(q.getByText(/将录制：窗口 400×300/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.recStart).toHaveBeenCalledWith(
      expect.objectContaining({ x: 300, y: 100, w: 400, h: 300 }),
    );
  });

  it("预览条读数实时写明「将录制」谁", async () => {
    const q = await mount();
    expect(q.getByText(/将录制：整个屏幕 1280×720/)).toBeTruthy();
    await act(async () => {
      fireEvent.mouseMove(root(q), { clientX: 350, clientY: 150 });
    });
    expect(q.getByText(/将录制：窗口 400×300/)).toBeTruthy();
  });

  // ===== 审查 P1：读数在「确认 / 倒计时」两态不许消失（承诺成立的两态信息量最低）=====
  it("确认条也写着「将录制」（改前红：ConfirmBar 里没有这条读数）", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.mouseMove(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.mouseDown(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.mouseUp(root(q), { clientX: 350, clientY: 150 });
    });
    expect(q.getByText(/将录制：窗口 400×300/)).toBeTruthy();
  });

  it("倒计时层也写着「将录制」（最后可中止的那一秒必须说清在中止什么）", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    expect(q.getByText(/将录制：整个屏幕 1280×720/)).toBeTruthy();
  });
});

describe("甲案 审查 P1：整屏必须有鼠标路径（§17 鼠标全流程可达）", () => {
  it("悬停出窗口 → 读数变成按钮「… 改录整屏」，点它 = 放弃窗口，再按开始录制录整屏", async () => {
    const q = await mount([WIN, WIN_BG]);
    await act(async () => {
      fireEvent.mouseMove(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: /改录整屏/ }));
    });
    // 控制与反馈同一可见性域（规则 15.1）：点完读数自己就改成整屏
    expect(q.getByText(/将录制：整个屏幕 1280×720/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.recStart).toHaveBeenCalledWith(
      expect.objectContaining({ x: 0, y: 0, w: 1280, h: 720 }),
    );
  });

  it("没悬停任何窗口时不给死控件（读数不是按钮）", async () => {
    const q = await mount();
    expect(q.queryByRole("button", { name: /改录整屏/ })).toBeNull();
  });
});

describe("甲案 审查 P2：⋯ 浮层的选项语义", () => {
  // 选 `aria-pressed` 而不是 `role="radio"`：radio + radiogroup 的既定期望是**方向键**在档间移动、
  // roving tabindex；只贴 role 不实现方向键 = 半套语义，比不贴更误导读屏用户。
  // 本仓音源两个开关本来就用 aria-pressed（启发式 4：同类控件同一写法）。
  it("画质四档暴露选中态（改前红：只有 class，读屏听不出哪档在用）", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "⋯" }));
    });
    expect(q.getByRole("group", { name: "画质档位" })).toBeTruthy();
    expect(q.getByRole("button", { name: "高清" }).getAttribute("aria-pressed")).toBe("true");
    expect(q.getByRole("button", { name: "流畅" }).getAttribute("aria-pressed")).toBe("false");
    // 触发器与浮层的关系也要能读出来
    expect(q.getByRole("button", { name: "⋯" }).getAttribute("aria-controls")).toBe("rec-pop");
    expect(q.getByRole("group", { name: "画质与声音" }).getAttribute("id")).toBe("rec-pop");
  });
});

describe("甲案② 画质/音源收进 ⋯，结果留在条上（规则 15.1）", () => {
  it("默认态条上就写着「高清 · 🔊」，不开浮层也看得见", async () => {
    const q = await mount();
    expect(q.getByText(/高清\s*·\s*🔊/)).toBeTruthy();
    // 四档技术名词不再摆在最高频路径上
    expect(q.queryByRole("button", { name: "原画" })).toBeNull();
  });

  it("⋯ 展开改档 → 徽标同步；音源同理", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "⋯" }));
    });
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "流畅" }));
    });
    expect(q.getByText(/流畅\s*·\s*🔊/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: /系统声音/ }));
    });
    expect(q.getByText(/流畅\s*·\s*无声/)).toBeTruthy();
  });

  it("浮层开着时按 Esc 只关浮层，不退出选屏（§18 两级取消）", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "⋯" }));
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(api.recCloseWindows).not.toHaveBeenCalled();
    expect(q.queryByRole("button", { name: "原画" })).toBeNull(); // 浮层已收起
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(api.recCloseWindows).toHaveBeenCalled(); // 第二级才退出
  });
});

describe("现网既有行为不得回归", () => {
  it("Esc 两级取消照旧（预览退出 / 确认回预览）", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.mouseMove(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.mouseDown(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.mouseUp(root(q), { clientX: 350, clientY: 150 });
    });
    // 进确认态：Esc 回预览，不关窗
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(api.recCloseWindows).not.toHaveBeenCalled();
    expect(q.getByText(/将录制/)).toBeTruthy();
    // 预览态：Esc 退出
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(api.recCloseWindows).toHaveBeenCalled();
  });

  it("单击采纳窗口后进确认态，确认条的「开始录制」仍录那扇窗", async () => {
    const q = await mount();
    await act(async () => {
      fireEvent.mouseMove(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.mouseDown(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.mouseUp(root(q), { clientX: 350, clientY: 150 });
    });
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.recStart).toHaveBeenCalledWith(
      expect.objectContaining({ x: 300, y: 100, w: 400, h: 300 }),
    );
  });
});
