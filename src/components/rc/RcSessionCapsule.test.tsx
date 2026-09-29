/**
 * RcSessionCapsule 守卫单测（2026-09-24 控端态浮条收编）。
 *
 * 浮现策略是本组件的灵魂，也是回归风险最大的地方，全部落成断言：
 * - 首显 15s 后自动隐藏（用户指定的 B 变体核心参数）；
 * - 悬停保持 / 离开 2.5s 淡出（viewTools 同款状态机）；
 * - 链路异常锁显 + 重连贴警示 + 微光条（异常永远有两个可见信号）；
 * - 旧版对端提示**不**锁显（整场常驻的条件锁了浮条就永远藏不回去）；
 * - 隐藏态 P2-12（aria-hidden + tabIndex=-1）；
 * - 结束/申请控制权走父级 confirmDialog 回调（红线：这里不得自行弹窗）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RcSession } from "@/lib/api/rc";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import type { UseRc } from "@/hooks/useRc";
import { useAppStore } from "@/stores/appStore";
import { RcSessionCapsule } from "./RcSessionCapsule";
import styles from "./RemoteComputer.module.css";

// 全屏态的窗口键走 lib/rcWindowOps 的 Rust 命令出口（原 RcFullscreenHotbar 的
// 口径），`invoke` 打桩；`@tauri-apps/api/window` 给 WindowControlIcon 的宿主
// 一组 spy。vitest 环境没有 `__TAURI_INTERNALS__`，用例里补上再清掉。
//
// 乙档起 `asks` 参与浮条状态（把手染橙 + 自动展开一次的判据），所以打桩
// useRcFile（与 RcControlBanner.test.tsx 同一手法）——真 store 要 Tauri 事件才能喂。
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  asks: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: h.isMaximized,
    onResized: h.onResized,
  }),
}));
vi.mock("@/hooks/useRcFile", () => ({
  useRcFile: () => ({
    asks: h.asks,
    tasks: [],
    running: 0,
    rateOf: () => 0,
    summary: null,
    busy: false,
    error: null,
    send: vi.fn(),
    pull: vi.fn(),
    respond: vi.fn(),
    cancel: vi.fn(),
    clearFinished: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const SESSION = {
  peer: "peer-a",
  peer_name: "办公室-台式机",
  capability: "control",
  phase: "outbound_active",
  started_ms: 1_700_000_000_000,
  granted: true,
} as unknown as RcSession;

const LINK: RcLinkSnapshot = { rttMs: 12, state: "connected", frameIdleSec: 0, unansweredSec: 0 };

const INPUT = {
  kbOn: false,
  pointerLocked: false,
  releaseKb: vi.fn(),
  togglePointerLock: vi.fn(),
} as unknown as Parameters<typeof RcSessionCapsule>[0]["input"];

const SEND = {
  qualities: [{ key: "high", label: "高清", tip: "" }],
  scopes: [{ key: "virtual", label: "整屏", tip: "" }],
  bitrateOptions: [{ key: "100", label: "100%", tip: "" }],
  canCycleScreen: false,
  cycleScreen: vi.fn(),
  pickQuality: vi.fn(),
  pickScope: vi.fn(),
  pickBitrate: vi.fn(),
} as unknown as Parameters<typeof RcSessionCapsule>[0]["send"];

const RC = { busy: false, status: {} } as unknown as UseRc;

function makeStage() {
  return { current: document.createElement("div") };
}

function base(over: Partial<Parameters<typeof RcSessionCapsule>[0]> = {}) {
  const stage = makeStage();
  const props: Parameters<typeof RcSessionCapsule>[0] = {
    session: SESSION,
    rc: RC,
    busy: false,
    canControl: true,
    link: LINK,
    input: INPUT,
    send: SEND,
    quality: "high",
    scopePick: "virtual",
    bitrate: 100,
    audioOn: true,
    onToggleAudio: vi.fn(),
    clipAuto: false,
    onToggleClipAuto: vi.fn(),
    lastAutoAt: 0,
    autoFail: 0,
    onStatus: vi.fn(),
    fit: "fit",
    onFit: vi.fn(),
    fullscreen: false,
    onToggleFullscreen: vi.fn(),
    onRequestEnd: vi.fn(),
    onReconnect: vi.fn(),
    onRequestControl: undefined,
    stageRef: stage,
    detail: <div data-testid="detail" />,
    ...over,
  };
  return props;
}

function zone(container: HTMLElement) {
  return container.querySelector(`.${styles.capZone}`);
}

/**
 * 🔴 乙档（2026-09-29）起「收起」的载体从 .capZone 下移到 .capFloat：把手与微光条
 * 住在 .capZone 直下、常驻不被卸载，所以 aria-hidden 只落在胶囊那一团上。
 * 断言「收起/展开」一律看这一层；root 只用于承载 onMouseLeave。
 */
function float(container: HTMLElement) {
  return container.querySelector(`.${styles.capFloat}`);
}

function handle(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(`.${styles.capHandle}`)!;
}

// ── 甲方案（2026-09-29）几何桩用：jsdom 的矩形恒 0，顶缘热区必须自己造矩形才能测。
// 数值取真实几何——画面 800×600 贴顶，胶囊 margin-top 12px / 高 34px ⇒ 遮挡带 y 12–46。
function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubGeometry(container: HTMLElement, stage: HTMLElement) {
  stage.getBoundingClientRect = () => rect(0, 0, 800, 600);
  container.querySelector(`.${styles.capCapsule}`)!.getBoundingClientRect = () =>
    rect(100, 12, 300, 46);
}

function move(stage: HTMLElement, clientY: number) {
  act(() => {
    stage.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 150, clientY }));
  });
}

describe("RcSessionCapsule（控端浮条，B 变体：首显 15s）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.invoke.mockReset().mockResolvedValue(undefined);
    h.isMaximized.mockReset().mockResolvedValue(false);
    h.onResized.mockReset().mockResolvedValue(() => {});
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("连接成功首显：身份段（可控胶囊 + 键盘提示）与画质下拉都在", () => {
    const { container, getByRole } = render(<RcSessionCapsule {...base()} />);
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
    expect(container.textContent).toContain("办公室-台式机");
    expect(container.textContent).toContain("可控");
    expect(container.textContent).toContain("点画面可捕获键盘");
    expect(getByRole("button", { name: /画质/ })).toBeTruthy();
    expect(getByRole("button", { name: "画面 整屏" })).toBeTruthy();
    expect(getByRole("button", { name: "结束会话" })).toBeTruthy();
  });

  it("15s 无交互后自动隐藏（用户指定的首显时长）", () => {
    const { container } = render(<RcSessionCapsule {...base()} />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("15s 内悬停胶囊保持显示（正在去点按钮，不计时）", () => {
    const props = base();
    const { container } = render(<RcSessionCapsule {...props} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
      // jsdom 矩形全 0：mousemove 必然命中胶囊本体（overCap）
      props.stageRef.current!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
  });

  it("悬停后离开 → 2.5s 淡出（viewTools 同款状态机）", () => {
    const props = base();
    const { container } = render(<RcSessionCapsule {...props} />);
    act(() => {
      props.stageRef.current!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    act(() => {
      fireEvent.mouseLeave(zone(container)!);
      vi.advanceTimersByTime(2_500);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("🔴 乙-⑥：链路异常不再永久锁显——首显到点照常收起，但把手染红 + 微光条收起态仍亮", () => {
    // 原口径（2026-09-23 拍板的「异常锁显」）让遮挡带 y 12–46 一路留到会话结束，
    // 正是甲方案要修的原点。乙把告知职责交给**不被卸载**的那一层：把手整枚染红
    // + 微光条常显，胶囊因此可以正常收起。
    const { container } = render(
      <RcSessionCapsule {...base({ link: { ...LINK, state: "failed" } })} />,
    );
    expect(container.textContent).toContain("已断开");
    expect(container.querySelector(`.${styles.capAlarmOn}`)).not.toBeNull();
    expect(container.querySelector(`.${styles.capZone}`)!.textContent).toContain("重连");
    expect(handle(container).className).toContain(styles.capHandleBad);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
    // 🔴 规则 15.1 的判据：胶囊收走了，异常的两个信号一个都不许跟着被 visibility 带走
    expect(container.querySelector(`.${styles.capAlarmOn}`)).not.toBeNull();
    expect(handle(container).getAttribute("aria-hidden")).toBe("false");
  });

  it("🔴 乙-⑥：会话中途断线 ⇒ 自动展开一次提示，2.5s 后收起（不锁到会话结束）", () => {
    const { container, rerender } = render(<RcSessionCapsule {...base()} />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");

    rerender(<RcSessionCapsule {...base({ link: { ...LINK, state: "failed" } })} />);
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
    expect(handle(container)).not.toBeNull();
  });

  it("操作后无画面（unansweredSec>0）出警示胶囊但不再锁显（2026-09-27 审查修订）", () => {
    // 旧判据 unanswered 参与锁显在静止画面上是病态的：被控端对静止画面刻意
    // 不推帧，无害点击本就无新帧 ⇒ 浮条锁几分钟不消失。现在锁显只跟「展开中的
    // 菜单/面板」走（乙-⑥ 把链路也请出了锁显），琥珀胶囊仍出，到点正常淡出。
    const { container } = render(
      <RcSessionCapsule {...base({ link: { ...LINK, unansweredSec: 3 } })} />,
    );
    expect(container.textContent).toContain("操作后 3s 无画面");
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("旧版对端「版本偏旧」只随浮条呈现，不锁显——整场常驻的条件不能把浮条钉死", () => {
    const rc = { busy: false, status: { peer_dgram_input: false } } as unknown as UseRc;
    const { container } = render(<RcSessionCapsule {...base({ rc })} />);
    expect(container.textContent).toContain("对方版本偏旧");
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  /**
   * 🔴 B11（2026-09-25）的机制不变，但触发者换了：乙-⑥ 起链路异常不再锁显，
   * 挂载即锁显的场景改由 ⋯ 面板承担（用户一连上就点 ⋯）。锁显会清掉 15s 首显
   * 计时，解锁分支必须按**剩余时长**重排——原缺陷正是解锁后什么都不排，shown
   * 恒 true，浮条整场不消失。
   */
  it("🔴 B11：首显窗口被锁显（⋯ 面板）打断时计时暂停，解锁后按剩余时长淡出", () => {
    // 🔴 必须用 within(container)：RTL 的 render 返回的查询绑在 document.body 上，
    // 这条用例连着挂了三个组件，body 级的 getByRole 会一次撞上三颗 ⋯ 键。
    const openMore = (c: HTMLElement) =>
      fireEvent.click(within(c).getByRole("button", { name: /更多/ }));
    const closeMore = () => {
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
    };

    // ① 锁显贯穿整个首显窗口：超时也不淡出（菜单还开着，收起会把面板晾成孤儿）
    const a = render(<RcSessionCapsule {...base()} />);
    openMore(a.container);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(float(a.container)!.getAttribute("aria-hidden")).toBe("false");

    // ② 锁显中只过了 5s：解锁后首显窗口还剩 10s（不是 15s，也不是 2.5s）
    const b = render(<RcSessionCapsule {...base()} />);
    openMore(b.container);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    closeMore();
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(float(b.container)!.getAttribute("aria-hidden")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(float(b.container)!.getAttribute("aria-hidden")).toBe("true");

    // ③ 锁显超过首显窗口才解锁：剩余 ≤0 → 走正常 2.5s 淡出（不会瞬隐）
    const c = render(<RcSessionCapsule {...base()} />);
    openMore(c.container);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    closeMore();
    act(() => {
      vi.advanceTimersByTime(2_499);
    });
    expect(float(c.container)!.getAttribute("aria-hidden")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(float(c.container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("🔴 Esc 两级取消：⋯ 面板展开时按 Esc 收起面板（不落到结束会话确认）", () => {
    const onRequestEnd = vi.fn();
    const { container, getByRole } = render(<RcSessionCapsule {...base({ onRequestEnd })} />);
    fireEvent.click(getByRole("button", { name: /更多/ }));
    expect(container.querySelector(`.${styles.capMore}`)).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector(`.${styles.capMore}`)).toBeNull();
    expect(onRequestEnd).not.toHaveBeenCalled();
  });

  it("隐藏态 P2-12：aria-hidden + 按钮 tabIndex=-1，不进 Tab 环", () => {
    const { container } = render(<RcSessionCapsule {...base()} />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    const end = container.querySelector<HTMLButtonElement>(`[aria-label="结束会话"]`);
    expect(end!.tabIndex).toBe(-1);
  });

  it("结束会话只触发父级回调（confirmDialog 在父级，这里不得自行弹窗）", () => {
    const onRequestEnd = vi.fn();
    const { getByRole } = render(<RcSessionCapsule {...base({ onRequestEnd })} />);
    fireEvent.click(getByRole("button", { name: "结束会话" }));
    expect(onRequestEnd).toHaveBeenCalledTimes(1);
  });

  it("只看态：出「申请控制权」，画面下拉/下一屏不摆（现行门禁不变）", () => {
    const onRequestControl = vi.fn();
    const { container, getByRole, queryByRole } = render(
      <RcSessionCapsule {...base({ canControl: false, onRequestControl })} />,
    );
    expect(container.textContent).toContain("只看");
    fireEvent.click(getByRole("button", { name: /申请控制权/ }));
    expect(onRequestControl).toHaveBeenCalledTimes(1);
    expect(queryByRole("button", { name: "画面 整屏" })).toBeNull();
    // 画质（流控）只看仍可调；适应/1:1/填充是本机显示，同样保留
    expect(getByRole("button", { name: /画质/ })).toBeTruthy();
    expect(getByRole("button", { name: "适应" })).toBeTruthy();
  });

  /**
   * 🔴 P1-1（2026-09-27 审计）：三键曾经一条规则都不匹配。
   *
   * 原写法 `className={fit === k ? styles.capBtnOn : undefined}` —— 未选中档是
   * `undefined`，而全库**没有** button 重置（globals.css 只有 `*{margin:0;padding:0}`），
   * 于是「适应 / 1:1 / 填充」退回浏览器原生按钮：实测 2px outset 黑框 / 圆角 0 /
   * `rgb(240,240,240)` 浅灰底 / Arial 13.3333px / 高 21px，而紧挨着的全屏键是
   * border 0 / 圆角 8 / 透明底 / 12px / 高 24px。
   *
   * 之所以必须用**渲染出来的 className** 断言：这条缺陷对 tsc / eslint / lint:ui /
   * lint:css **全部不可见**（className 有值、`.capBtnOn` 这个类也确实存在，
   * 只是没接上）。把 `styles.capBtn` 从 JSX 里删掉，只有这条用例会红。
   */
  it("🔴 P1-1：适应/1:1/填充三键都落在 .capBtn 上，当前档再多一层 .capBtnOn", () => {
    const { getByRole, rerender } = render(<RcSessionCapsule {...base({ fit: "fit" })} />);
    const has = (label: string, cls: string) =>
      getByRole("button", { name: label }).classList.contains(cls);

    for (const label of ["适应", "1:1", "填充"]) {
      expect(has(label, styles.capBtn)).toBe(true);
    }
    // 当前档：叠 .capBtnOn；另外两档**不得**叠（否则三键都是蓝底，选中态失效）
    expect(has("适应", styles.capBtnOn)).toBe(true);
    expect(has("1:1", styles.capBtnOn)).toBe(false);
    expect(has("填充", styles.capBtnOn)).toBe(false);

    // 换一档后蓝底跟着走（不是写死在某一颗上）
    rerender(<RcSessionCapsule {...base({ fit: "actual" })} />);
    expect(has("1:1", styles.capBtnOn)).toBe(true);
    expect(has("适应", styles.capBtnOn)).toBe(false);
  });

  it("🔴 P1-1：三键与同排的全屏键同族（同一个 .capBtn 类，不再退回原生外观）", () => {
    const { getByRole, container } = render(<RcSessionCapsule {...base({ fit: "fill" })} />);
    const fullscreen = getByRole("button", { name: "全屏显示远程画面（F11）" });
    expect(fullscreen.classList.contains(styles.capBtn)).toBe(true);

    // 「同族」的操作化定义：三键的类名 = 全屏键的类名（未选中档），
    // 当前档只允许多出 .capBtnOn 一个 —— 多出别的说明又走回了补丁式写法。
    const fullCls = fullscreen.className.split(/\s+/).sort();
    for (const label of ["适应", "1:1", "填充"]) {
      const got = getByRole("button", { name: label })
        .className.split(/\s+/)
        .filter((c) => c !== styles.capBtnOn)
        .sort();
      expect(got).toEqual(fullCls);
    }
    expect(container.querySelector(`.${styles.capFit}`)).not.toBeNull();
  });

  it("🔴 2026-09-27：结束会话键必须挂在 .capBtn 基底上（曾只有 capBtnDanger ⇒ 原生白底按钮）", () => {
    const { getByRole } = render(<RcSessionCapsule {...base()} />);
    const end = getByRole("button", { name: "结束会话" });
    expect(end.classList.contains(styles.capBtn)).toBe(true);
    expect(end.classList.contains(styles.capBtnDanger)).toBe(true);
  });

  it("⋯ 面板开合：点击展开（码率/声音/重连收纳位），点外面收", () => {
    const { container, getByRole } = render(<RcSessionCapsule {...base()} />);
    expect(container.querySelector(`.${styles.capMore}`)).toBeNull();
    fireEvent.click(getByRole("button", { name: /更多/ }));
    const more = container.querySelector(`.${styles.capMore}`);
    expect(more).not.toBeNull();
    expect(more!.textContent).toContain("码率");
    expect(more!.textContent).toContain("重连");
    // 面板展开期间锁显（portal 菜单/面板上的鼠标移动不经过画面热区）
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector(`.${styles.capMore}`)).toBeNull();
  });
});

/**
 * 🔴 方案 A（2026-09-28，design/远程电脑-控端全屏胶囊统一-设计稿.html）：
 * 全屏不再换第二条控制条（RcFullscreenHotbar 退役），两态同一条胶囊。
 * 这里接管原 hotbar 测试钉住的三条语义：入口不丢、关闭走 rc_window_close、
 * F10 键盘唤出；并新增「两态一致」这条回归判据（分叉一次就会重演
 * 「全屏里改不了画质」）。
 */
describe("RcSessionCapsule 全屏态（两态同一条）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.invoke.mockReset().mockResolvedValue(undefined);
    h.isMaximized.mockReset().mockResolvedValue(false);
    h.onResized.mockReset().mockResolvedValue(() => {});
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("🔴 全屏里五类入口一个都不少：画质 / 画面 / 显示三键 / ⓘ 详情 / ⋯ 面板", () => {
    const { container, getByRole, getByTestId } = render(
      <RcSessionCapsule {...base({ fullscreen: true })} />,
    );
    expect(getByRole("button", { name: /画质/ })).toBeTruthy();
    expect(getByRole("button", { name: "画面 整屏" })).toBeTruthy();
    for (const label of ["适应", "1:1", "填充"]) {
      expect(getByRole("button", { name: label })).toBeTruthy();
    }
    expect(getByRole("button", { name: /更多/ })).toBeTruthy();
    expect(getByTestId("detail")).toBeTruthy();
    // 顶栏退场 ⇒ 胶囊贴屏幕顶缘（.capZoneFs），窗口态不吃这个类
    expect(container.querySelector(`.${styles.capZoneFs}`)).not.toBeNull();
  });

  it("窗口态不吃 .capZoneFs（顶栏还在，胶囊让开一整条 chrome）", () => {
    const { container } = render(<RcSessionCapsule {...base()} />);
    expect(container.querySelector(`.${styles.capZoneFs}`)).toBeNull();
  });

  it("🔴 全屏右端补窗口键：最小化 + 关闭走 Rust 命令，最大化不摆（全屏里无意义）", () => {
    render(<RcSessionCapsule {...base({ fullscreen: true })} />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(h.invoke).toHaveBeenCalledWith("rc_window_minimize");
    expect(h.invoke).toHaveBeenCalledWith("rc_window_close");
    // 只打三键命令集（原 RcFullscreenHotbar 的同一条断言）：关闭必须是 close
    // 语义，交给「有会话先问」的窗口守卫，不许绕成 destroy 或结束会话。
    const cmds = h.invoke.mock.calls.map((c) => c[0]);
    expect(cmds.every((c) => typeof c === "string" && c.startsWith("rc_window_"))).toBe(true);
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });

  it("窗口态不摆窗口键（最小化/最大化/关闭仍归顶条，同屏只有一套）", () => {
    render(<RcSessionCapsule {...base()} />);
    expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("同一颗全屏键翻转语义：全屏里翻成文字键「退出全屏」（稿子 §3-A①，非图标-only）", () => {
    const onToggleFullscreen = vi.fn();
    const { getByRole } = render(
      <RcSessionCapsule {...base({ fullscreen: true, onToggleFullscreen })} />
    );
    const key = getByRole("button", { name: "退出全屏" });
    expect(key.textContent).toBe("退出全屏");
    expect(key.getAttribute("title")).toBe("退出全屏显示远程画面（F11）");
    fireEvent.click(key);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it("F10 唤出/收起（热键从 hotbar 上收，两态通用）；kbOn 时让路给远端", () => {
    const { container, rerender } = render(<RcSessionCapsule {...base()} />);
    act(() => {
      vi.advanceTimersByTime(15_000); // 首显到点淡出
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      fireEvent.keyDown(window, { key: "F10" });
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");

    // 键盘已捕获给远端 ⇒ 热键不生效，已显示的不被收起
    rerender(<RcSessionCapsule {...base({ input: { ...INPUT, kbOn: true } })} />);
    act(() => {
      fireEvent.keyDown(window, { key: "F10" });
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");

    rerender(<RcSessionCapsule {...base()} />);
    act(() => {
      fireEvent.keyDown(window, { key: "F10" });
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("🔴 甲方案②：顶缘快速穿过（不足 180ms）不唤出浮条", () => {
    const props = base();
    const { container } = render(<RcSessionCapsule {...props} />);
    stubGeometry(container, props.stageRef.current!);
    act(() => {
      vi.advanceTimersByTime(15_000); // 首显到点淡出
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");

    move(props.stageRef.current!, 1); // 顶缘 3px 带内
    act(() => {
      vi.advanceTimersByTime(100); // dwell 未到期
    });
    move(props.stageRef.current!, 300); // 穿过顶缘继续往下 = 离开热区
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(`.${styles.capZoneThru}`)).toBeNull();
  });

  it("🔴 甲方案②③：顶缘站住 180ms 才唤出，唤出后 200ms 内浮条不参与命中测试", () => {
    const props = base();
    const { container } = render(<RcSessionCapsule {...props} />);
    stubGeometry(container, props.stageRef.current!);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    move(props.stageRef.current!, 1);
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
    expect(container.querySelector(`.${styles.capZoneThru}`)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(200); // 穿透窗口收口：看得见也就点得着了
    });
    expect(container.querySelector(`.${styles.capZoneThru}`)).toBeNull();
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");

    act(() => {
      vi.advanceTimersByTime(2_500); // 正常 2.5s 淡出（reveal 时也计上了）
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("甲方案①：从画面内部往上够 y=12 的标签栏，路径不经过 3px 热区 ⇒ 全程不唤出", () => {
    const props = base();
    const { container } = render(<RcSessionCapsule {...props} />);
    stubGeometry(container, props.stageRef.current!);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    for (const y of [200, 100, 40, 12]) {
      move(props.stageRef.current!, y);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
  });
});

/**
 * 🔴 P1-1 的样式表侧：选中档在**悬停**时也必须保住底色。
 *
 * `.capBtn:hover:not(:disabled)` 的特异性是 (0,3,0)，高过 `.capBtnOn` 的 (0,1,0)。
 * 修前靠 `.capBtnOn` 的两条 `!important` 硬压（行为对、但写法和「禁 !important」
 * 的收口方向相反）；修法把 hover 规则改成 `:not(:disabled):not(.capBtnOn)`。
 *
 * 这里**不钉某一种写法**，只钉不变量：两种手法至少有一个在场。
 * 两个都被拿掉时，鼠标一停在当前档上蓝底就被灰白 hover 底盖掉 ——
 * 选中态在指针下消失。这条断言在那一刻变红。
 */
describe("RcSessionCapsule 样式表（P1-1）", () => {
  const CSS = readFileSync(
    join(process.cwd(), "src", "components", "rc", "RemoteComputer.module.css"),
    "utf8",
  );

  function block(selector: string): string {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
    if (!m) throw new Error(`找不到规则块 ${selector}`);
    return m[1];
  }

  it("选中档在悬停时不会被 hover 规则盖掉（排除写法或 !important 至少有一个）", () => {
    // hover 规则的选择器本身可能被改写（修法是往 :not() 链上追加），
    // 所以连选择器带声明一起取出来，别只找固定的那一串。
    const hoverRule = CSS.match(/(?:^|\n)(\.capBtn:hover[^{]*)\{([^}]*)\}/);
    expect(hoverRule, "找不到 .capBtn:hover 规则").not.toBeNull();
    const [, hoverSel, hoverBody] = hoverRule!;
    const on = block(".capBtnOn");
    const excluded = hoverSel.includes(":not(.capBtnOn)");
    const forced = on.includes("!important");
    expect(
      excluded || forced,
      `hover 规则（${hoverSel.trim()}）既不排除 .capBtnOn，.capBtnOn 也没有 !important`
        + " —— 鼠标停在当前档上蓝底就被灰白 hover 底盖掉，选中态消失",
    ).toBe(true);
    // 顺带确认 hover 规则确实会改底色（不然这条断言是空转的）
    expect(hoverBody).toMatch(/background:/);
  });

  it("三键靠的是 .capBtn 一族，样式表里不存在专给 .capFit 里裸 button 的补丁规则", () => {
    // 修前的正确解法是「给三键挂 .capBtn」，不是再写一条 `.capFit button`。
    // 后者会让三键与同排按钮继续分家（字号/高度/圆角各走一套）。
    expect(CSS).not.toMatch(/\.capFit\s+button/);
    expect(CSS).not.toMatch(/\.capFit\s*>\s*button/);
  });

  it("🔴 展开态把手让位必须落在命中盒上（正数 z-index 不是让位）", () => {
    // 层叠的坑：`.capZone`（z-index:5）是层叠上下文，里面的 `.capCapsule` 是
    // position:relative + z-index:auto ⇒ 画在第 8 步；把手只要挂**任何正数**
    // z-index 就在第 9 步，4 和 6 一样压着胶囊。所以「把 .capHandleBehind 的
    // z-index 从 6 改成 4」这种写法看着像让位，实际什么都没改。
    const base = CSS.match(/(?:^|\n)\.capHandleBehind\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base, ".capHandleBehind 不许再用正数 z-index 冒充让位").not.toMatch(/z-index:\s*[1-9]/);

    // 真正的让位：展开时收回 ::after 那 9px 下探。命中盒下缘不得越过胶囊上缘，
    // 否则鼠标往胶囊上沿（那排 .capBtn 的顶部）点下去，接住这一击的是把手
    // = 「点按钮却把浮条收起来了」。
    const behind = block(".capHandleBehind::after");
    const bottom = Number(/bottom:\s*(-?\d+(?:\.\d+)?)(?:px)?\b/.exec(behind)?.[1]);
    expect(Number.isFinite(bottom), ".capHandleBehind::after 必须显式收回 bottom").toBe(true);
    const px = (sel: string, prop: string) =>
      Number(new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)(?:px)?\\b`).exec(block(sel))?.[1]);
    const handleH = px(".capHandle", "height");
    const capTop = px(".capCapsule", "margin-top");
    // 下探量为负数才外扩（bottom:-4px ⇒ 命中到 12+4=16），取 -min(bottom,0) 即可；
    // 不扣那 1px 下边框，判据偏保守（宁可误报也不漏报）。
    expect(
      handleH + Math.max(0, -bottom),
      `展开态命中下缘 ${handleH + Math.max(0, -bottom)}px 越过了胶囊上缘 ${capTop}px`,
    ).toBeLessThanOrEqual(capTop);
  });

  it("🔴 存量修复：收起态的 visibility 必须等淡出结束（否则「2.5s 淡出」是瞬隐）", () => {
    // 特异性坑：`.viewToolsHidden`（单类，1089 行）和宿主 `.capFloat`（单类，1229 行）
    // 同分，后写的赢 ⇒ 基准态那条 `visibility 0s linear 0s` 会把收起态一起管走，
    // t=0 就隐形，200ms 的 opacity/transform 动画根本没被看见。
    // 修法只允许一种语义：收起态由一条**更高特异性**的规则把 visibility 推迟，
    // 且推迟量 = 淡出时长（显示方向仍要 0s，否则淡入第一帧看不见）。
    const base = block(".capFloat");
    const fade = Number(/opacity\s+(\d+)ms/.exec(base)?.[1]);
    expect(Number.isFinite(fade), ".capFloat 的淡出时长读不出来").toBe(true);
    const hidden = CSS.match(/(?:^|\n)\.capFloat\.viewToolsHidden\s*\{([^}]*)\}/);
    expect(hidden, "找不到 .capFloat.viewToolsHidden —— 只靠 .viewToolsHidden 自己那条会被 .capFloat 覆盖").not
      .toBeNull();
    const delay = Number(/visibility\s+0s\s+linear\s+(\d+)ms/.exec(hidden![1])?.[1]);
    expect(delay, "收起态必须给 visibility 加延迟").toBe(fade);
    // 显示方向不许带延迟（淡入第一帧就要可见），这条钉住别被「顺手统一」改回去。
    expect(/visibility\s+0s\s+linear\s+0s/.test(base), ".capFloat 基准态的 visibility 延迟必须是 0").toBe(true);
  });

  it("🔴 C 项（2026-09-29 拍板）：收起态把手下探吃进遮挡带不许超过 4px", () => {
    // 遮挡带（胶囊那一团，画面 y 12–46）正是甲方案整轮在让的东西；把手多吃的
    // 像素里，**可见**的 24×12 在带外（它是常驻出口，已拍板），但 `::after` 的下探
    // 会伸进带里。原来收的是 -9px（吃进 8px，全屏态正压在远端标签 ✕ 那一行），
    // 现在 4px。这条守卫防的是「有人觉得 15px 不够点，顺手改回 -9」。
    const px = (sel: string, prop: string) =>
      Number(new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)(?:px)?\\b`).exec(block(sel))?.[1]);
    const after = block(".capHandle::after");
    const bottom = Number(/bottom:\s*(-?\d+(?:\.\d+)?)(?:px)?\b/.exec(after)?.[1]);
    expect(Number.isFinite(bottom), ".capHandle::after 必须显式写 bottom").toBe(true);
    const probe = bottom < 0 ? -bottom : 0;
    // 判据按**保守**方向算：不扣那 1px 下边框（padding box 11 才是真基准，
    // 用 12 会让允许的侵入深度多算 1px，宁可误报也不漏报）。
    const encroach = px(".capHandle", "height") + probe - px(".capCapsule", "margin-top");
    expect(encroach, `收起态把手吃进遮挡带 ${encroach}px（上限 4px）`).toBeLessThanOrEqual(4);
    // 下探本身不许被删成 0：把手只有 12px 高，一点容错都不留就点不着了
    expect(probe, "下探归零 ⇒ 命中只剩可见的 24×12，太薄").toBeGreaterThan(0);
  });

  it("🔴 F 项（2026-09-29 拍板）：ask 态整枚染色，外挂徽标已退役（窗缘会裁它）", () => {
    // 右上角那枚 7px 橙点 `top:-3px` 天生探出把手上缘：窗口态上面还有自己的顶栏，
    // 全屏态 `.capZoneFs{top:0}` 直接把它裁掉 3px。改成与 .capHandleBad 同构的整块色，
    // 就没有「会被窗缘裁的元素」这一类了。
    expect(CSS, ".capHandleAsk 必须自己带底色（整枚染色），否则 ask 态什么都看不见").toMatch(
      /(?:^|\n)\.capHandleAsk\s*\{[^}]*background:/,
    );
    expect(CSS, "外挂徽标已退役——不许改回点，也不许留一条只给全屏的特例选择器").not.toMatch(
      /\.capHandleAskDot/,
    );
    const TSX = readFileSync(
      join(process.cwd(), "src", "components", "rc", "RcCapsuleHandle.tsx"),
      "utf8",
    );
    expect(TSX).not.toMatch(/capHandleAskDot/);
    // 橙比红亮得多：白点在橙底上不到 3:1，所以两档的电点必须反向
    expect(block(".capHandleBad .capHandleKnob")).toMatch(/background:\s*#fff/);
    expect(block(".capHandleAsk .capHandleKnob")).not.toMatch(/background:\s*#fff/);
  });
});

/**
 * 🔴 乙档（2026-09-29）常驻把手。design/远程电脑-浮条角标化-乙-设计稿.html §7。
 *
 * 把手补的是甲方案落地后剩下的 R1「收起态零出口」：胶囊淡出后画面上一条 UI 都不剩。
 * 所以这里的断言重心不是外观，而是**层级与可见性域**（规则 15.1）：
 * 把手与微光条必须是 `.capZone` 的直系子元素，绝不能住进被 `visibility:hidden`
 * 带走的 `.capFloat`——否则收起态又回到「异常只剩一个看不见的灯」。
 */
describe("RcCapsuleHandle（乙档常驻把手）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.invoke.mockReset().mockResolvedValue(undefined);
    h.isMaximized.mockReset().mockResolvedValue(false);
    h.onResized.mockReset().mockResolvedValue(() => {});
    h.asks = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    useAppStore.getState().updateConfig({ rc_hover_reveal: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    h.asks = [];
    useAppStore.getState().updateConfig({ rc_hover_reveal: true });
  });

  /** 收起（首显 15s 到点）后返回，此时画面只剩把手 + 微光条。 */
  function collapsed() {
    const props = base();
    const r = render(<RcSessionCapsule {...props} />);
    stubGeometry(r.container, props.stageRef.current!);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(float(r.container)!.getAttribute("aria-hidden")).toBe("true");
    return { ...r, props };
  }

  it("🔴 收起态把手仍在场，且是 .capZone 的直系子元素（不住进被隐藏的子树）", () => {
    const { container } = collapsed();
    const hd = handle(container);
    expect(hd).toBeTruthy();
    expect(hd.parentElement).toBe(zone(container));
    expect(float(container)!.contains(hd)).toBe(false);
    expect(hd.getAttribute("aria-expanded")).toBe("false");
    expect(hd.getAttribute("aria-hidden")).toBe("false");
    // aria-controls 必须真的指到那一团被收起的胶囊（否则屏幕阅读器读的是空引用）
    expect(hd.getAttribute("aria-controls")).toBe(float(container)!.id);
  });

  it("展开时把手让位（.capHandleBehind）：两个可点元素不抢同一击", () => {
    const { container } = render(<RcSessionCapsule {...base()} />);
    expect(handle(container).getAttribute("aria-expanded")).toBe("true");
    expect(handle(container).className).toContain(styles.capHandleBehind);
  });

  it("🔴 点把手 = 展开，2.5s 无交互再收起（顶缘零触发也走得通）", () => {
    const { container } = collapsed();
    fireEvent.click(handle(container));
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
    expect(handle(container).getAttribute("aria-expanded")).toBe("true");
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
    // 收起态仍是「有出口」的状态：把手没跟着被卸载
    expect(handle(container)).toBeTruthy();
  });

  it("🔴 乙-①：关掉顶缘悬停唤出 ⇒ 顶缘站满 180ms 也不弹，把手照常能点开", () => {
    useAppStore.getState().updateConfig({ rc_hover_reveal: false });
    const { container, props } = collapsed();
    move(props.stageRef.current!, 1); // 顶缘 3px 带内
    act(() => {
      vi.advanceTimersByTime(1_000); // 远超 dwell 180ms
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(`.${styles.capZoneThru}`)).toBeNull();

    fireEvent.click(handle(container));
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
  });

  it("🔴 锁系统指针 ⇒ 把手隐形且退出 Tab 环（点不着的东西不占键盘）", () => {
    const { container } = render(
      <RcSessionCapsule
        {...base({ input: { ...INPUT, pointerLocked: true } as typeof INPUT })}
      />,
    );
    const hd = handle(container);
    expect(hd.className).toContain(styles.capHandleDim);
    expect(hd.getAttribute("aria-hidden")).toBe("true");
    expect(hd.tabIndex).toBe(-1);
  });

  it("🔴 乙：对端文件请求到达 ⇒ 自动展开一次 + 把手整枚染橙常驻（收起也不灭）", () => {
    const props = base();
    const { container, rerender } = render(<RcSessionCapsule {...props} />);
    stubGeometry(container, props.stageRef.current!);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");

    h.asks = [{ id: "ask-1", peer: "peer-a" }];
    rerender(<RcSessionCapsule {...props} />);
    expect(float(container)!.getAttribute("aria-hidden")).toBe("false");
    expect(handle(container).className).toContain(styles.capHandleAsk);

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(float(container)!.getAttribute("aria-hidden")).toBe("true");
    // 规则 15.1：告知必须和触发同可见性域 —— 请求还挂着，染橙就不许随胶囊淡出
    expect(handle(container).className).toContain(styles.capHandleAsk);
    expect(handle(container).getAttribute("title")).toContain("有等你处理的");
  });

  it("⋯ 面板「顶缘悬停唤出」一行：翻转偏好并落盘 save_config（乙-① 的写路径）", async () => {
    const { container, getByRole } = render(<RcSessionCapsule {...base()} />);
    fireEvent.click(getByRole("button", { name: /更多/ }));
    const row = getByRole("button", { name: /顶缘悬停唤出/ });
    expect(row.getAttribute("aria-pressed")).toBe("true");

    // toggleHoverReveal 是乐观写 + 串行 save_config 的 promise 链，要冲微任务
    await act(async () => {
      fireEvent.click(row);
    });
    expect(useAppStore.getState().config.rc_hover_reveal).toBe(false);
    expect(h.invoke).toHaveBeenCalledWith(
      "save_config",
      expect.objectContaining({
        config: expect.objectContaining({ rc_hover_reveal: false }),
      }),
    );
    // 🔴 反馈与触发同层（规则 15.1）：行内的当前值就地改口，不靠别处的 toast
    expect(
      getByRole("button", { name: /顶缘悬停唤出/ }).textContent,
    ).toContain("关（只剩把手与 F10）");
    expect(container).toBeTruthy();
  });

  it("保存失败 ⇒ 回滚偏好并出声（不能静默留下一个假开关）", async () => {
    h.invoke.mockRejectedValueOnce(new Error("save failed"));
    const { getByRole } = render(<RcSessionCapsule {...base()} />);
    fireEvent.click(getByRole("button", { name: /更多/ }));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: /顶缘悬停唤出/ }));
    });
    // 回滚 + toast 都在 .catch 里，链条要多冲一轮才落到最终态
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().config.rc_hover_reveal).toBe(true);
  });
});
