/**
 * RcNearbyPairPane（常驻配对卡 / 统一入口）的守卫测试。
 *
 * 钉住四件在产品上「错了也看不出来」的事：
 * ① 配对码核对屏 8 位、4+4 分组——位数或分组口径改错，用户逐位比对时就废了；
 * ② 一轮配对没成时卡里出现结束条——没有它，失败会被渲染成「空列表」（U3）；
 * ③ `done` 被另一个读者拿走时，靠 targets 兜底判成功，不误报「配对已结束」；
 * ④ 暂停接收的提示说的是真实行为（能配对、连不上），不是「看不到你」。
 *
 * ❗ 两个 mock 约定，都是**后端真实行为**而不是测试迁就：
 *  - `rcNearbyStatus` 在 `rcNearbyPair` 之后必须返回那轮配对。`useRcNearbyPair`
 *    在 `pair` 变化时会立刻补一轮 refresh（用户刚点完按钮不能干等下一轮），
 *    mock 返回 `pair: null` 会把刚进的那层核对屏当场擦掉。
 *  - 配对进行中的轮询间隔是 2 秒，所以涉及状态翻转的断言用 `POLL` 放宽超时。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import type { RcNeighbor, RcPairDone, RcPairPrompt } from "@/lib/api/rcPair";
import { RcNearbyPairPane } from "./RcNearbyPairPane";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  pair: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/api/rcPair", () => ({
  rcNearbyStatus: api.status,
  rcNearbyPair: api.pair,
  rcNearbyConfirm: api.confirm,
  rcNearbyCancel: api.cancel,
}));

/** 窗口可见性：hook 靠它决定要不要轮询。测试里恒为可见。 */
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));
vi.mock("@/lib/dialogMotion", () => ({ useDialogAnim: () => ({ backdrop: {}, panel: {} }) }));

/** 轮询间隔 2s > waitFor 默认 1s，翻转状态的断言统一放宽。 */
const POLL = { timeout: 6000, interval: 50 } as const;

function neighbor(): RcNeighbor {
  return { node_id: "peer-1", name: "这台手机", addr: "192.168.1.9:5009", last_seen_ms: Date.now() };
}

function prompt(over: Partial<RcPairPrompt> = {}): RcPairPrompt {
  return {
    peer_id: "peer-1",
    peer_name: "这台手机",
    pin: "41820620",
    initiator: true,
    me_ok: false,
    peer_ok: false,
    started_ms: Date.now(),
    ...over,
  };
}

function done(over: Partial<RcPairDone> = {}): RcPairDone {
  return { peer_id: "peer-1", peer_name: "这台手机", initiator: true, at_ms: Date.now(), ...over };
}

/**
 * 装一轮「从列表点进去」的配对：start 之前轮询给列表态，start 之后给核对态
 * （与后端一致）。返回的 `finish` 用来把这一轮推到结束（成功 / 失败两种）。
 */
function mockRoundTrip(p: RcPairPrompt = prompt()) {
  let started = false;
  api.pair.mockImplementation(async () => {
    started = true;
    return p;
  });
  api.status.mockImplementation(async () =>
    started
      ? { neighbors: [neighbor()], pair: p, done: null }
      : { neighbors: [neighbor()], pair: null, done: null }
  );
  return {
    /** 这一轮成功：两端都确认，后端写下 `done`。 */
    finish() {
      api.status.mockResolvedValue({ neighbors: [], pair: null, done: done() });
    },
    /** 这一轮没成：pair 消失且没有 `done`（对方取消 / 超时 / 本端 gone）。 */
    finishNoDone() {
      api.status.mockResolvedValue({ neighbors: [], pair: null, done: null });
    },
  };
}

function renderPane(opts?: { targets?: { node_id: string }[] }) {
  const rc = {
    status: { enabled: true, running: true },
    targets: opts?.targets ?? [],
    refreshTargets: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => true),
  } as unknown as UseRc;
  const toast = vi.fn();
  const onPairMore = vi.fn();
  render(<RcNearbyPairPane rc={rc} toast={toast} onPairMore={onPairMore} />);
  return { rc, toast, onPairMore };
}

beforeEach(() => {
  api.status.mockReset();
  api.pair.mockReset();
  api.confirm.mockReset();
  api.cancel.mockReset();
  api.status.mockResolvedValue({ neighbors: [], pair: null, done: null });
});

describe("首页只显示来访确认", () => {
  it("附近列表有设备也不常驻展示", async () => {
    api.status.mockResolvedValue({ neighbors: [neighbor()], pair: null, done: null });
    const rc = { status: { enabled: true, running: true }, targets: [], refreshTargets: vi.fn() } as unknown as UseRc;
    const view = render(<RcNearbyPairPane rc={rc} toast={vi.fn()} onPairMore={vi.fn()} requestsOnly />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });
  it("对方主动发起时弹窗核对，取消仍可用", async () => {
    api.status.mockResolvedValue({ neighbors: [], pair: prompt({ initiator: false }), done: null });
    const rc = { status: { enabled: true, running: true }, targets: [], refreshTargets: vi.fn() } as unknown as UseRc;
    render(<RcNearbyPairPane rc={rc} toast={vi.fn()} onPairMore={vi.fn()} requestsOnly />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "收到配对请求" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "不一样，取消" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalled());
  });
});

describe("RcNearbyPairPane · 单一入口", () => {
  it("常驻卡露面：标题 + 副标题 + 主按钮，附近为空也把主按钮当第一行动", async () => {
    renderPane();
    await waitFor(() => expect(screen.getByRole("region", { name: "附近的设备" })).toBeTruthy());
    expect(screen.getByText("附近的设备")).toBeTruthy();
    expect(screen.getByText(/自动发现同一个网络里的设备/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "＋ 配对新设备" })).toBeTruthy();
  });

  it("点主按钮打开配对界面（不自己判内网/公网）", async () => {
    const { onPairMore } = renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: "＋ 配对新设备" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "＋ 配对新设备" }));
    expect(onPairMore).toHaveBeenCalledTimes(1);
  });

  it("邻居出现后可点「配对」，卡内原地切核对屏（不开弹层）", async () => {
    mockRoundTrip();
    renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /^配对$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^配对$/ }));
    await waitFor(() => expect(screen.getByText("与「这台手机」配对")).toBeTruthy());
    // 卡内切换：核对屏在卡片 region 里，没有 dialog 角色
    expect(screen.getByRole("region", { name: "附近的设备" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("RcNearbyPairPane · 配对码展示口径", () => {
  it("8 位配对码按 4+4 展示（4182 0620）", async () => {
    mockRoundTrip();
    renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /^配对$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^配对$/ }));
    await waitFor(() => expect(screen.getByText("4182 0620")).toBeTruthy());
    // 未分组的裸串不许出现（那会让用户多数一位）
    expect(screen.queryByText("41820620")).toBeNull();
  });

  it("没协商出码之前不进确认态（确认键禁用，文案说在等什么）", async () => {
    mockRoundTrip(prompt({ pin: "" }));
    renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /^配对$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^配对$/ }));
    await waitFor(() => expect(screen.getByText(/正在与对方建立一次性加密信道/)).toBeTruthy());
    // 项目没装 jest-dom，断言 disabled 属性本身（判据与 toBeDisabled 等价）。
    expect((screen.getByRole("button", { name: "两边一样，确认" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RcNearbyPairPane · 失败不许渲染成空（U3）", () => {
  it("配对消失且没 done、对端也不在列表 → 卡里出现结束条 + 重新发起", async () => {
    const round = mockRoundTrip();
    const { onPairMore } = renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /^配对$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^配对$/ }));
    await waitFor(() => expect(screen.getByText("4182 0620")).toBeTruthy());

    // 对端取消：pair 没了，也没有 done
    round.finishNoDone();
    await waitFor(() => expect(screen.getByText(/这次配对已经结束了/)).toBeTruthy(), POLL);
    fireEvent.click(screen.getByRole("button", { name: "重新发起" }));
    expect(onPairMore).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(/这次配对已经结束了/)).toBeNull());
  });

  it("本端点确认后 gone → 同样给结束条，不静默弹回列表", async () => {
    const round = mockRoundTrip();
    api.confirm.mockResolvedValue({ state: "gone", peer_id: "peer-1", peer_name: "这台手机" });
    renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /^配对$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^配对$/ }));
    await waitFor(() => expect(screen.getByText("4182 0620")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "两边一样，确认" }));
    // gone 之后端上会话已经没了：把轮询推到「pair 消失」，结束条该出现。
    round.finishNoDone();
    await waitFor(() => expect(screen.getByText(/这次配对已经结束了/)).toBeTruthy(), POLL);
  }, 10_000);
});

describe("RcNearbyPairPane · done 单读者的兜底", () => {
  it("看不到 done 但对端已在设备列表 → 不误报结束，也不补 toast", async () => {
    const round = mockRoundTrip();
    const { rc, toast } = renderPane({ targets: [{ node_id: "peer-1" }] });
    await waitFor(() => expect(screen.getByRole("button", { name: /^配对$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^配对$/ }));
    await waitFor(() => expect(screen.getByText("4182 0620")).toBeTruthy());

    // pair 消失、done 被另一个读者拿走（null），但 targets 里已经有这台
    round.finishNoDone();
    await waitFor(() => expect(screen.queryByText("4182 0620")).toBeNull(), POLL);
    expect(screen.queryByText(/这次配对已经结束了/)).toBeNull();
    // 成功那一声不补：避免与看得见 done 的那一侧双弹
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("已与"), "success");
    // 设备已经在列表里，没有需要刷的东西——不刷才是对的（多一次 IPC 不会更准）
    expect(rc.refreshTargets).not.toHaveBeenCalled();
  }, 10_000);

  it("看得见 done 且是本卡发起 → 成功 toast + 刷新列表", async () => {
    const round = mockRoundTrip();
    const { rc, toast } = renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /^配对$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^配对$/ }));
    await waitFor(() => expect(screen.getByText("4182 0620")).toBeTruthy());

    round.finish();
    await waitFor(
      () => expect(toast).toHaveBeenCalledWith(expect.stringContaining("已与「这台手机」配对"), "success"),
      POLL
    );
    await waitFor(() => expect(rc.refreshTargets).toHaveBeenCalled(), POLL);
    expect(screen.queryByText(/这次配对已经结束了/)).toBeNull();
  });
});

describe("RcNearbyPairPane · 暂停提示说真实行为", () => {
  it("暂停接收时提示「仍能配对、连不上」，并给一去开启", async () => {
    const setEnabled = vi.fn(async () => true);
    const rc = {
      status: { enabled: false, running: true },
      targets: [],
      refreshTargets: vi.fn(async () => {}),
      setEnabled,
    } as unknown as UseRc;
    render(<RcNearbyPairPane rc={rc} toast={vi.fn()} onPairMore={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/仍能和你配对，但连不上你/)).toBeTruthy());
    // 不写「看不到你」——招呼包与开关无关（rc_enabled 只管会话建立）
    expect(screen.queryByText(/看不到你/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "去开启" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
  });
});
