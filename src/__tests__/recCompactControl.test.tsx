import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecControlBar } from "@/components/recsel/RecControlBar";
import { flushResize, installResizeObserver, lastObservedTarget, resetResizeObserver, stubBox } from "@/test-helpers/resizeObserver";

// jsdom 不带 ResizeObserver，而 RecControlBar 挂载即构造它（尺寸 effect）——不装桩
// 整个文件开局就抛。桩只装在本文件：装进共享 test-setup.dom.ts 会让**所有** jsdom
// 测试里的 `typeof ResizeObserver === "undefined"` 守卫翻转分支（手机端 KnowledgeList、
// useSheetDrag 都靠这条守卫在 jsdom 里活命），2026-10-16 全局装过一次，满载下
// KnowledgeView.test.tsx 随机判红，已收口到这里。可控语义见 helper 文件头。
installResizeObserver();

const mocks = vi.hoisted(() => ({
  status: vi.fn(), pause: vi.fn(), resize: vi.fn(),
}));
vi.mock("@/lib/api/rec", () => ({
  recStatus: mocks.status, recSetPaused: mocks.pause, recResizeControl: mocks.resize,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

/**
 * 上报窗口尺寸的那条链（2026-10-16 改口径）：
 * 改前尺寸是 TS 里算的常量（260/288/80/104/128 × 28/36 五个数散在组件里），可以直接断死；
 * 改后 = `.surface` 的**实测**盒子，所以测试要替 jsdom「量」一次再喂回调。
 *
 * 🔴 桩值刻意**避开旧公式那五个常量**（用 271×37 这类旧实现永远算不出的数）：
 * 若哪天有人把尺寸退回硬编码公式，这些断言会当场变红，而不是碰巧撞上同样几个数字。
 * 🔴 元素不按 class 名取（CSS Modules 的类名在测试里带哈希），走 observer 的登记。
 *
 * 防假绿记录（2026-10-16 实测，还原三种缺陷形态各跑一次）：
 * ① `const w = 260; const h = 36;` 代回 offsetWidth/offsetHeight ⇒ 7 条红、10 条绿；
 * ② 去掉同尺寸去重（只留 `!w || !h`）⇒ 只有 "re-measures the same box only once" 红；
 * ③ 去掉零尺寸拦截（只留同尺寸去重）⇒ 只有 "never collapses the window to zero" 红。
 * ⚠️ ③ 第一次写的是「一上来就量 0」：那时 `lastSize` 初值就是 {0,0}，去重顺手挡住了 0×0，
 * 于是**去掉拦截也照样全绿**——已改成「先量正常尺寸、再量 0」，这才是真实故障形态。
 */
async function measure(w: number, h: number) {
  const surface = lastObservedTarget();
  if (!surface) throw new Error("组件没有把任何节点交给 ResizeObserver——尺寸上报的入口丢了");
  stubBox(surface, w, h);
  await act(async () => { flushResize(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetResizeObserver();
  mocks.status.mockReset();
  mocks.pause.mockReset();
  mocks.resize.mockReset();
  mocks.status.mockResolvedValue({ recording: true, finalizing: false, paused: false,
    elapsedMs: 12500, bytes: 1024, quality: "high", warnings: [],
    sysAudio: true, micAudio: false, sysAudioActive: true, micAudioActive: false });
  mocks.pause.mockResolvedValue(undefined);
  mocks.resize.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const runningStatus = { recording: true, finalizing: false, paused: false,
  elapsedMs: 12500, bytes: 1024, quality: "high", warnings: [] };

describe("compact recording control", () => {
  it("uses backend elapsed time and keeps low-frequency actions under More", async () => {
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await screen.findByText("00:12");
    expect(screen.queryByRole("button", { name: "丢弃" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("button", { name: "丢弃录像" })).toBeTruthy();
    // 面板里音源只留名字（§5.1）：「开 / 关」交给两枚点的实心 / 空心。
    // sysAudioActive=true ⇒ 第一枚带态类（实心），micAudio 未开 ⇒ 第二枚无态类（空心）。
    const snd = screen.getByText(/电脑声音/);
    const dots = snd.querySelectorAll("i");
    expect(dots.length).toBe(2);
    expect(dots[0].className).not.toBe("");
    expect(dots[1].className).toBe("");
  });

  it("reports the measured surface box, not a formula (a new branch must be measured again)", async () => {
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await screen.findByText("00:12");
    await measure(271, 37);
    expect(mocks.resize).toHaveBeenLastCalledWith(271, 37);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    // 收起态是另一个 .surface 节点 ⇒ observer 里最新那条才是当前这一屏的
    await measure(83, 29);
    expect(mocks.resize).toHaveBeenLastCalledWith(83, 29);
    fireEvent.click(screen.getByRole("button", { name: /展开录屏控制条/ }));
    await measure(271, 37);
    expect(mocks.resize).toHaveBeenLastCalledWith(271, 37);
  });

  it("re-measures the same box only once (no redundant native resize per tick)", async () => {
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await screen.findByText("00:12");
    await measure(271, 37);
    expect(mocks.resize).toHaveBeenCalledTimes(1);
    // 盒子没变：第 2、3 次回调都不该再打扰原生窗口（每秒一次的状态轮询会带出这些回调）
    await act(async () => { flushResize(); flushResize(); });
    expect(mocks.resize).toHaveBeenCalledTimes(1);
    await measure(272, 37);
    expect(mocks.resize).toHaveBeenCalledTimes(2);
  });

  it("never collapses the window to zero when the surface measures 0 mid-recording", async () => {
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await screen.findByText("00:12");
    await measure(271, 37);
    expect(mocks.resize).toHaveBeenLastCalledWith(271, 37);
    // 🔴 必须先量到一个正常尺寸，再量 0：`lastSize` 初值就是 {0,0}，所以「一上来就量 0」
    // 会被同尺寸去重顺手挡掉，那条写法**证明不了零尺寸拦截存在**（实测：去掉 `!w || !h`
    // 后它照样全绿）。真实故障形态是「浮条中途被隐藏（样式或父级 display:none）→ 量到 0」，
    // 此时若上报，原生窗变成 0×0 直接消失，用户只能看见录制还在跑却没有任何出口。
    await measure(0, 0);
    expect(mocks.resize).toHaveBeenCalledTimes(1);
  });

  it("explains a pause failure beside its trigger", async () => {
    mocks.pause.mockRejectedValueOnce(new Error("设备暂不可用"));
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    // 🔴 就绪判据是**计时器落到 00:12**（= status 已返回），不是「按钮出现了」：
    // status 未落地时 `preparing` 为真，暂停键根本不渲染，`getByRole` 会直接抛错。
    await screen.findByText("00:12");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "暂停" })));
    expect((await screen.findByRole("alert")).textContent).toContain("暂停失败");
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("leaves a recoverable stop action after stop rejects", async () => {
    render(<RecControlBar qualityLabel="高清" finalizing={false}
      onStop={vi.fn().mockRejectedValue(new Error("磁盘暂不可用"))} />);
    await screen.findByRole("button", { name: "暂停" });
    await act(async () => fireEvent.click(screen.getByTitle("停止并保存")));
    expect((await screen.findByRole("alert")).textContent).toContain("停止失败");
    expect(screen.getByRole("button", { name: "重试停止" })).toBeTruthy();
  });

  it("does not invent a running clock or offer pause before status arrives", async () => {
    mocks.status.mockReturnValue(deferred<typeof runningStatus>().promise);
    const onStop = vi.fn();
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={onStop} />);
    expect(screen.getByText("--:--")).toBeTruthy();
    expect(screen.getByText("正在确认")).toBeTruthy();
    expect(screen.queryByLabelText("录制中")).toBeNull();
    // 🔴 准备态**不渲染**暂停键，而不是渲染成 disabled：此时后端还没开录，点了必失败。
    // 旧版留一枚 68px 的灰按钮，既点不动，又把准备态撑到 336px（超过窗口初值 320，
    // 右侧「更多」被裁）。别把它加回来当占位——要宽度就用 `.state` 文案本身。
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止并保存" })));
    expect(onStop).toHaveBeenCalledWith(false);
  });

  it("clears only a recovered status query error", async () => {
    vi.useFakeTimers();
    mocks.status.mockRejectedValueOnce(new Error("查询失败"));
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("无法确认录制状态");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("00:12")).toBeTruthy();
  });

  it.each(["暂停", "停止"])("does not clear a real %s failure when the status query recovers", async action => {
    vi.useFakeTimers();
    mocks.status.mockResolvedValueOnce(runningStatus).mockRejectedValueOnce(new Error("查询失败"));
    mocks.pause.mockRejectedValueOnce(new Error("操作失败"));
    render(<RecControlBar qualityLabel="高清" finalizing={false}
      onStop={vi.fn().mockRejectedValue(new Error("操作失败"))} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: action === "停止" ? "停止并保存" : action })));
    expect(screen.getByRole("alert").textContent).toContain(`${action}失败`);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("alert").textContent).toContain(`${action}失败`);
    expect(screen.getByRole("alert").textContent).not.toContain("无法确认录制状态");
  });

  it("keeps a visible and accessible warning entrance after manually collapsing", async () => {
    mocks.status.mockResolvedValue({ ...runningStatus, warnings: ["麦克风不可用"] });
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "收起提示" }));
    fireEvent.click(screen.getByRole("button", { name: "录制异常详情" }));
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    const tiny = screen.getByRole("button", { name: /展开录屏控制条.*异常/ });
    expect(tiny.textContent).toContain("异常");
    expect(tiny.querySelector(".lucide-triangle-alert")).toBeTruthy();
    // 收起态（带「异常」角标）也要上报它自己的尺寸——不复量就会沿用展开态的窗口宽度，
    // 浮条外多出一块看不见但吃点击的透明区。
    await measure(137, 29);
    expect(mocks.resize).toHaveBeenLastCalledWith(137, 29);
    fireEvent.click(tiny);
    expect(screen.getByRole("button", { name: "录制异常详情" })).toBeTruthy();
  });

  it.each([false, true])("offers the matching retry after a pause command failure (paused=%s)", async paused => {
    mocks.status.mockResolvedValue({ ...runningStatus, paused });
    mocks.pause.mockRejectedValueOnce(new Error("暂不可用"));
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await screen.findByText("00:12");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: paused ? "继续" : "暂停" })));
    const retry = screen.getByRole("button", { name: paused ? "重试继续" : "重试暂停" });
    await act(async () => fireEvent.click(retry));
    expect(mocks.pause).toHaveBeenLastCalledWith(!paused);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: paused ? "暂停" : "继续" })).toBeTruthy();
  });

  it("ignores a slow status response started before a successful pause", async () => {
    vi.useFakeTimers();
    const slow = deferred<typeof runningStatus>();
    mocks.status.mockResolvedValueOnce(runningStatus).mockReturnValueOnce(slow.promise);
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={vi.fn()} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocks.status).toHaveBeenCalledTimes(2);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "暂停" })));
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
    await act(async () => slow.resolve(runningStatus));
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
  });

  it.each(["parent", "backend"])("restores a collapsed control to saving bounds when %s confirms finalizing", async source => {
    vi.useFakeTimers();
    const saving = deferred<typeof runningStatus>();
    const onStop = vi.fn();
    mocks.status.mockResolvedValueOnce(runningStatus).mockReturnValueOnce(saving.promise);
    const { rerender } = render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={onStop} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    await act(async () => {});
    await measure(83, 29);
    expect(mocks.resize).toHaveBeenLastCalledWith(83, 29);
    if (source === "parent") {
      rerender(<RecControlBar qualityLabel="高清" finalizing onStop={onStop} />);
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.queryByRole("status")).toBeNull();
      await act(async () => saving.resolve({ ...runningStatus, finalizing: true }));
    }
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toContain("正在保存录像");
    expect(screen.queryByRole("button")).toBeNull();
    // 保存态是第三个 .surface（整条换成一行「正在保存录像」）⇒ 必须重新量、重新上报，
    // 否则窗口还停在收起态的小尺寸，保存文案会被裁掉（正是这条用例的原始意图）。
    await measure(283, 39);
    expect(mocks.resize).toHaveBeenLastCalledWith(283, 39);
  });

  it("shows encoder preparation until the backend confirms readiness", async () => {
    vi.useFakeTimers();
    const ready = deferred<typeof runningStatus & { starting: boolean }>();
    mocks.status.mockResolvedValueOnce({ ...runningStatus, starting: true })
      .mockReturnValueOnce(ready.promise);
    const onStop = vi.fn();
    render(<RecControlBar qualityLabel="高清" finalizing={false} onStop={onStop} />);
    await act(async () => {});
    expect(screen.getByText("正在准备")).toBeTruthy();
    expect(screen.getByText("--:--")).toBeTruthy();
    expect(screen.queryByLabelText("录制中")).toBeNull();
    // 准备态不渲染暂停键（后端还没开录，点了必失败）：旧版留的 disabled 灰按钮
    // 既点不动，又把这一态撑到 336px —— 超过窗口初值 320，右侧「更多」被裁。
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    expect((screen.getByRole("button", { name: "停止并保存" }) as HTMLButtonElement).disabled).toBe(false);
    // 准备态实测 276×38（少了暂停键、多了「正在准备」文案）：窗口跟着缩，不是公式
    await measure(276, 38);
    expect(mocks.resize).toHaveBeenLastCalledWith(276, 38);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => ready.resolve({ ...runningStatus, starting: false }));
    expect(screen.queryByText("正在准备")).toBeNull();
    expect(screen.getByText("00:12")).toBeTruthy();
    expect((screen.getByRole("button", { name: "暂停" }) as HTMLButtonElement).disabled).toBe(false);
    // 同一个 .surface（只是文案变短）也要跟着收回来：靠 observer 再报一次，不是靠分支重挂
    await measure(271, 37);
    expect(mocks.resize).toHaveBeenLastCalledWith(271, 37);
  });
});
