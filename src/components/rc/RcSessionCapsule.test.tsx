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
import { act, fireEvent, render } from "@testing-library/react";
import type { RcSession } from "@/lib/api/rc";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import type { UseRc } from "@/hooks/useRc";
import { RcSessionCapsule } from "./RcSessionCapsule";
import styles from "./RemoteComputer.module.css";

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
  });
  afterEach(() => {
    vi.useRealTimers();
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

  it("操作后无画面（unansweredSec>0）锁显并出警示胶囊", () => {
    const { container } = render(
      <RcSessionCapsule {...base({ link: { ...LINK, unansweredSec: 3 } })} />,
    );
    expect(container.textContent).toContain("操作后 3s 无画面");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(zone(container)!.getAttribute("aria-hidden")).toBe("false");
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
