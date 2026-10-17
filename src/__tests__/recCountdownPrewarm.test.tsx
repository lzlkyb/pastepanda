/**
 * 录屏五期 乙案守卫（2026-10-11 实录：倒计时「1」停顿后才进录制，且「1」被录进成品开头）。
 *
 * 根因是**顺序**，不是速度：`beginRecording` 把「本窗隐身（穿透 + 卸载倒计时）」排在
 * `await recStart(...)` **之后**，而后端在 `rec_start` 里同步付掉「开硬件编码器 ≈2.8s」，
 * 于是这 2.8 秒里 DXGI 抓到的每一帧都还画着那个「1」。
 *
 * 钉四条不变量（全部是行为断言，不钉源码形状）：
 * ① 进倒计时那一刻就并行预热编码器（3 秒空档正好盖住启动开销）；
 * ② 🔴 预热的参数必须与稍后 `rec_start` 收到的一字不差——错一个字段后端键不命中，
 *    预热白做（两处各算一遍正是这个 bug 的孪生形式，规则 11.1）；
 * ③ 归零先把本窗清成录制中空态（穿透 + 倒计时数字从 DOM 消失）**再**发起 rec_start；
 * ④ 启动失败必须把交互还回来（穿透撤销 + 回确认条 + 玻璃条文案）——隐身是先付的成本。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { waitUntilRenderedContent } from "@/test-helpers/waitUntil";

const api = vi.hoisted(() => ({
  recGetScreen: vi.fn(),
  recStart: vi.fn(),
  recPrewarm: vi.fn(),
  recReady: vi.fn(),
  recStop: vi.fn(),
  recCloseWindows: vi.fn(),
  recTakeRerecord: vi.fn(),
  setIgnore: vi.fn(),
  hide: vi.fn(),
  show: vi.fn(),
  /** 跨模块的顺序取证：谁先发生，数组里就谁在前。 */
  order: [] as string[],
}));

vi.mock("@/lib/api/rec", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api/rec");
  return {
    ...actual,
    recGetScreen: api.recGetScreen,
    recStart: api.recStart,
    recPrewarm: api.recPrewarm,
    recReady: api.recReady,
    recStop: api.recStop,
    recCloseWindows: api.recCloseWindows,
    recTakeRerecord: api.recTakeRerecord,
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFocus: () => Promise.resolve(),
    hide: api.hide,
    show: api.show,
    setIgnoreCursorEvents: (v: boolean) => {
      api.order.push(v ? "穿透" : "交互归还");
      return api.setIgnore(v);
    },
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { RecSelectOverlay } from "@/components/recsel/RecSelectOverlay";
import { TargetFrames } from "@/components/recsel/RecTargetFrames";

/** 1280×720 虚拟屏，dpr=1（jsdom 默认）⇒ CSS 像素与物理像素同值。 */
const SCREEN = { originX: 0, originY: 0, width: 1280, height: 720 };

function mount() {
  api.recGetScreen.mockResolvedValue(SCREEN);
  api.recStart.mockResolvedValue(undefined);
  api.recPrewarm.mockResolvedValue(undefined);
  api.recReady.mockResolvedValue(undefined);
  api.recStop.mockResolvedValue(undefined);
  api.recCloseWindows.mockResolvedValue(undefined);
  api.recTakeRerecord.mockResolvedValue(null);
  api.setIgnore.mockResolvedValue(undefined);
  api.hide.mockResolvedValue(undefined);
  api.show.mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "enum_window_rects" ? [] : cmd === "rec_audio_check" ? { sysAudio: true, micAudio: true, warnings: [] } : undefined),
  );
  return render(<RecSelectOverlay config={null} />);
}

/**
 * 就绪判据 = 预览条读数真的落地了（组件在 screen 未就位前整体 return null）。
 *
 * 🔴 判据改成逐字写死的尺寸，不写 `/将录制/`：2026-10-16 苹果风重做把「将录制 + 来源」
 * 这段前缀从视觉里删了（§5.1，那六个字现在只留在 `title` 里），`queryByText` 不匹配
 * title ⇒ 旧探针会永远等不到。期望值按 `SCREEN`（1280×720）与 dpr=1 逐字算出来：
 * `phys(v) = Math.max(16, Math.round(v) & ~1)` ⇒ `1280 × 720`（偶数对齐后原值不变）。
 * 这里刻意不 import `recTarget` 去算期望值——期望值取自被测常量会让探针永远为真。
 */
async function mounted() {
  const q = mount();
  await waitUntilRenderedContent(() => !!q.queryByText("1280 × 720"), "预览条读数（屏参已落地）");
  return q;
}

const startBtn = (q: ReturnType<typeof render>) => q.getByRole("button", { name: /开始录制/ });

/**
 * 走完倒计时（3 秒）并多冲一拍：`beginRecording` 在发起 rec_start 前等一次
 * requestAnimationFrame 把「隐身」画进合成帧——假计时器把它当成 ~16ms 的定时器，
 * 它挂在最后一格倒计时之后，所以要留出一拍给它。
 * 🔴 一次一格地推进（倒计时是「setState → effect 里再挂 setTimeout」的自链）。
 */
async function runCountdown() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  api.order.length = 0;
  vi.useFakeTimers();
});

describe("乙案①② 倒计时一开始就预热，且预热的就是要开录的那份参数", () => {
  it("进倒计时即调 recPrewarm（改前红：这个命令还不存在，一次都不会调）", async () => {
    const q = await mounted();
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    expect(api.recPrewarm).toHaveBeenCalledTimes(1);
    expect(q.getByText("3")).toBeTruthy();
    expect(api.recStart).not.toHaveBeenCalled(); // 预热不等于开录：3 秒内不许抢跑
  });

  it("🔴 预热参数与 3 秒后 rec_start 收到的完全同一份（键不命中就等于没预热）", async () => {
    const q = await mounted();
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.recStart).toHaveBeenCalledTimes(1);
    expect(api.recPrewarm.mock.calls[0][0]).toEqual(api.recStart.mock.calls[0][0]);
  });

  it("改档后再开录：预热的档位跟着变（两处共用同一条换算，规则 11.1）", async () => {
    const q = await mounted();
    await act(async () => {
      // §5.1 把 `画质：高清` 的冒号删了（设置名与值之间本来就是空格分节，冒号是纯装饰）。
      // 这里连空格一起钉住，免得它被改回带冒号的写法。
      fireEvent.click(q.getByRole("button", { name: /^画质 / }));
    });
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "流畅" }));
    });
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.recPrewarm.mock.calls[0][0]).toEqual(expect.objectContaining({ quality: "smooth" }));
    expect(api.recPrewarm.mock.calls[0][0]).toEqual(api.recStart.mock.calls[0][0]);
  });
});

describe("乙案③ 归零先隐身再开录（「1」不许进成品）", () => {
  it("unmounts the recording border and its permanent animation", () => {
    const q = render(<TargetFrames phase="recording" recording rect={{ x: 0, y: 0, w: 800, h: 600 }}
      hoverRect={null} snapRect={null} screenCss={{ w: 1280, h: 720 }} />);
    expect(q.container.childElementCount).toBe(0);
  });
  it("hides the whole selector before capture and restores it after a start failure", async () => {
    const q = await mounted();
    api.recStart.mockImplementation(() => {
      expect(api.hide).toHaveBeenCalledTimes(1);
      return Promise.reject(new Error("启动失败"));
    });
    await act(async () => { fireEvent.click(startBtn(q)); });
    await runCountdown();
    expect(api.hide).toHaveBeenCalledTimes(1);
    expect(api.show).toHaveBeenCalledTimes(1);
    expect(q.getByRole("button", { name: /开始录制/ })).toBeTruthy();
  });
  it("顺序是 预热 → 穿透 → recStart，且 recStart 那一刻本窗已无倒计时数字", async () => {
    const q = await mounted();
    api.recPrewarm.mockImplementation(() => {
      api.order.push("prewarm");
      return Promise.resolve(undefined);
    });
    // 在 rec_start 被调用的**那一刻**取证：本窗还是不是画着倒计时数字
    let digitWhenStarted: string | null | "未取到证" = "未取到证";
    api.recStart.mockImplementation(() => {
      api.order.push("recStart");
      digitWhenStarted = q.container.textContent?.match(/[321]/)?.[0] ?? null;
      return Promise.resolve(undefined);
    });
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.order).toEqual(["prewarm", "穿透", "recStart"]);
    expect(digitWhenStarted).toBeNull();
  });
});

describe("乙案④ 先隐身再开录的退路：启动失败要把交互还回来", () => {
  it("rec_start 报错 → 撤销穿透 + 回确认态 + 玻璃条文案（隐身不能变成无出口）", async () => {
    const q = await mounted();
    api.recStart.mockRejectedValue(new Error("没有可用的硬件编码器（录屏不提供软编兜底）"));
    await act(async () => {
      fireEvent.click(startBtn(q));
    });
    await runCountdown();
    expect(api.setIgnore).toHaveBeenLastCalledWith(false);
    expect(api.order).toContain("交互归还");
    expect(q.getAllByText(/没能开始录制/).length).toBeGreaterThan(0);
  });
});
