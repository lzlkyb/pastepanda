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
import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RcSession } from "@/lib/api/rc";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import type { UseRc } from "@/hooks/useRc";
import { RcSessionCapsule } from "./RcSessionCapsule";
import styles from "./RemoteComputer.module.css";

// 全屏态的窗口键走 lib/rcWindowOps 的 Rust 命令出口（原 RcFullscreenHotbar 的
// 口径），`invoke` 打桩；`@tauri-apps/api/window` 给 WindowControlIcon 的宿主
// 一组 spy。vitest 环境没有 `__TAURI_INTERNALS__`，用例里补上再清掉。
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: h.isMaximized,
    onResized: h.onResized,
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
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");
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
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("true");
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
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");
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
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("链路 failed 锁显：重连贴着警示、微光条亮起，超时也不淡出", () => {
    const { container } = render(
      <RcSessionCapsule {...base({ link: { ...LINK, state: "failed" } })} />,
    );
    expect(container.textContent).toContain("已断开");
    expect(container.querySelector(`.${styles.capAlarmOn}`)).not.toBeNull();
    expect(container.querySelector(`.${styles.capZone}`)!.textContent).toContain("重连");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");
  });

  it("操作后无画面（unansweredSec>0）出警示胶囊但不再锁显（2026-09-27 审查修订）", () => {
    // 旧判据 unanswered 参与锁显在静止画面上是病态的：被控端对静止画面刻意
    // 不推帧，无害点击本就无新帧 ⇒ 浮条锁几分钟不消失。现在锁显只跟链路
    // 死活走，琥珀胶囊仍出（有提示），浮条到点正常淡出。
    const { container } = render(
      <RcSessionCapsule {...base({ link: { ...LINK, unansweredSec: 3 } })} />,
    );
    expect(container.textContent).toContain("操作后 3s 无画面");
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("旧版对端「版本偏旧」只随浮条呈现，不锁显——整场常驻的条件不能把浮条钉死", () => {
    const rc = { busy: false, status: { peer_dgram_input: false } } as unknown as UseRc;
    const { container } = render(<RcSessionCapsule {...base({ rc })} />);
    expect(container.textContent).toContain("对方版本偏旧");
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("true");
  });

  it("🔴 B11：挂载即锁显（connecting）时首显计时暂停，超时也不淡出；解锁后按剩余时长淡出", () => {
    // 缺陷场景：linkLocked 初值 true（connecting）清掉 15s 首显计时，解锁分支
    // 又什么都不排 → shown 恒 true，浮条整场不消失。
    const { container, rerender } = render(
      <RcSessionCapsule {...base({ link: { ...LINK, state: "connecting" } })} />,
    );
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");

    // 锁显中只过了 5s：解锁后首显窗口还剩 10s
    const { container: c2, rerender: rerender2 } = render(
      <RcSessionCapsule {...base({ link: { ...LINK, state: "connecting" } })} />,
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender2(<RcSessionCapsule {...base({ link: { ...LINK, state: "connected" } })} />);
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(zone(c2)!.getAttribute("aria-hidden")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(zone(c2)!.getAttribute("aria-hidden")).toBe("true");

    // 锁显超过首显窗口才解锁：剩余 ≤0 → 走正常 2.5s 淡出（不会瞬隐）
    rerender(<RcSessionCapsule {...base({ link: { ...LINK, state: "connected" } })} />);
    act(() => {
      vi.advanceTimersByTime(2_499);
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("true");
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
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");
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
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      fireEvent.keyDown(window, { key: "F10" });
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");

    // 键盘已捕获给远端 ⇒ 热键不生效，已显示的不被收起
    rerender(<RcSessionCapsule {...base({ input: { ...INPUT, kbOn: true } })} />);
    act(() => {
      fireEvent.keyDown(window, { key: "F10" });
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");

    rerender(<RcSessionCapsule {...base()} />);
    act(() => {
      fireEvent.keyDown(window, { key: "F10" });
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("true");
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
});
