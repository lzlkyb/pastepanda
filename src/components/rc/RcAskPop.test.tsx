/**
 * RcAskPop 守卫单测（丙-①②，2026-09-30）。
 *
 * 为什么要单测一块「只在有人敲门时才出现的置顶窗」：它的全部价值就在于**不会没人看见**，
 * 而它最容易坏的地方恰恰是接线——命令名、权限名单、两条授权档、两形态分流。这些都是
 * 「静默失败」型（tsc / eslint 全绿，界面上什么都不出来），只有渲染断言拦得住
 * （P1-1 那条教训：按钮没挂上基底 CSS，四个工具都没报错）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RcAskPop } from "./RcAskPop";
import { rcApproveInbound, rcAskHide, rcAskState, rcDenyInbound } from "@/lib/api/rcCommands";
import type { RcAskHost, RcAskMode, RcAskNote, RcInboundKnock, RcSession } from "@/lib/api/rc";

/** 批准成功的返回值这里没人读，只需要过类型。 */
const OK = { id: "s1" } as unknown as RcSession;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/lib/api/rcCommands", () => ({
  rcAskState: vi.fn(),
  rcAskHide: vi.fn().mockResolvedValue(undefined),
  rcApproveInbound: vi.fn().mockResolvedValue({}),
  rcDenyInbound: vi.fn().mockResolvedValue(undefined),
  rcEndSession: vi.fn().mockResolvedValue(undefined),
}));

const askState = vi.mocked(rcAskState);
const askHide = vi.mocked(rcAskHide);
const approve = vi.mocked(rcApproveInbound);
const deny = vi.mocked(rcDenyInbound);

const knock = (over: Partial<RcInboundKnock> = {}): RcInboundKnock => ({
  peer: "9f2ca71d000000000000000000000000000000000000000000000000000000000000abcd",
  peer_name: "DESKTOP-7K2",
  display_name: "",
  capability: "control",
  first_seen_ms: Date.now() - 13_000,
  ...over,
});

const note = (code: string): RcAskNote => ({ peer: "9f2c", code, at_ms: Date.now() });

const hostRow = (over: Partial<RcAskHost> = {}): RcAskHost => ({
  peer: "9f2c",
  display_name: "DESKTOP-7K2",
  capability: "control",
  started_ms: Date.now() - 161_000,
  ...over,
});

/**
 * 状态包。`mode` 由 Rust 的 `mode_of` 算，前端只分流——所以这里的默认值必须是
 * 「有申请待答」那一档，而不是留空让组件自己猜。
 */
function base(): { mode: RcAskMode; pending: RcInboundKnock[]; note: RcAskNote | null; host: RcAskHost | null } {
  return { mode: "ask", pending: [], note: null, host: null };
}
const st = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });

beforeEach(() => {
  askState.mockReset();
  askHide.mockReset().mockResolvedValue(undefined);
  approve.mockReset().mockResolvedValue(OK);
  deny.mockReset().mockResolvedValue(undefined);
});

describe("RcAskPop 待答复态", () => {
  it("说得出「谁 + 指纹 + 申请什么 + 还剩多久」，倒计时按后端那条的 first_seen 算", async () => {
    askState.mockResolvedValue(st({ pending: [knock()] }));
    render(<RcAskPop />);
    await screen.findByText(/DESKTOP-7K2 想远程这台电脑/);
    expect(screen.getByText(/看屏幕 \+ 控制键鼠/)).toBeTruthy();
    // 120 - 13 = 107s → 1:47（钉住「前端倒计时与后端 deadline 同一条算式」）
    expect(screen.getByText("1:47")).toBeTruthy();
  });

  it("分两次授权：申请可控才有「只同意看屏幕」，点了传 view 而不是 control", async () => {
    askState.mockResolvedValue(st({ pending: [knock()] }));
    render(<RcAskPop />);
    const viewBtn = await screen.findByRole("button", { name: "只同意看屏幕" });
    await act(async () => {
      fireEvent.click(viewBtn);
    });
    expect(approve).toHaveBeenCalledWith(expect.any(String), "view");
  });

  it("申请本来就只看 → 不重复摆「只同意看屏幕」", async () => {
    askState.mockResolvedValue(st({ pending: [knock({ capability: "view" })] }));
    render(<RcAskPop />);
    await screen.findByText(/只看屏幕/);
    expect(screen.queryByRole("button", { name: "只同意看屏幕" })).toBeNull();
  });

  it("多条一次只答一条（先敲门的先答），其余折成一行", async () => {
    const now = Date.now();
    askState.mockResolvedValue(
      st({
        pending: [
          knock({ peer_name: "晚到的", first_seen_ms: now - 5_000 }),
          knock({ peer_name: "先敲门的", first_seen_ms: now - 40_000 }),
        ],
      }),
    );
    render(<RcAskPop />);
    await screen.findByText(/先敲门的 想远程这台电脑/);
    expect(screen.queryByText(/晚到的 想远程这台电脑/)).toBeNull();
    expect(screen.getByText(/另有 1 条在等/)).toBeTruthy();
  });

  it("动作失败写在卡片里（独立 webview 没有 toast，静默失败等于没反馈）", async () => {
    askState.mockResolvedValue(st({ pending: [knock()] }));
    approve.mockRejectedValueOnce("门禁拒绝");
    render(<RcAskPop />);
    const goBtn = await screen.findByRole("button", { name: "同意远程" });
    await act(async () => {
      fireEvent.click(goBtn);
    });
    expect((await screen.findByText(/同意失败/)).textContent).toContain("门禁拒绝");
  });
});

describe("RcAskPop 原因行（设计稿 §丙-① 第③ 点）", () => {
  it("超时自动拒：pending 空了也要把那句话顶出来，而不是让那条静静消失", async () => {
    askState.mockResolvedValue(st({ note: note("confirm_timeout") }));
    render(<RcAskPop />);
    expect(await screen.findByText(/已自动拒绝/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
  });

  it("空列表且没有原因 = 一块吃鼠标面积的透明窗，必须自己收掉", async () => {
    askState.mockResolvedValue(st({ mode: "hidden" }));
    render(<RcAskPop />);
    await vi.waitFor(() => expect(askHide).toHaveBeenCalled());
  });

  it("🔴 首次 rc_ask_state 落回之前不许收窗（否则刚 show 的窗口会被第一帧按回去）", async () => {
    let release: (v: ReturnType<typeof st>) => void = () => {};
    askState.mockReturnValue(new Promise((r) => (release = r)));
    render(<RcAskPop />);
    await new Promise((r) => setTimeout(r, 30));
    expect(askHide).not.toHaveBeenCalled();
    release(st({ pending: [knock()] }));
    await screen.findByText(/想远程这台电脑/);
  });

  it("拒绝走的是同一条命令，不需要二次确认（误触的代价是对方重发一次）", async () => {
    askState.mockResolvedValue(st({ pending: [knock()] }));
    render(<RcAskPop />);
    const denyBtn = await screen.findByRole("button", { name: "拒绝" });
    await act(async () => {
      fireEvent.click(denyBtn);
    });
    expect(deny).toHaveBeenCalled();
  });
});

describe("RcAskPop 形态分流（丙-②）", () => {
  it("mode=capsule → 渲染角标而不是卡片，且**不**自己收窗（那是隐私指示）", async () => {
    askState.mockResolvedValue(st({ mode: "capsule", host: hostRow() }));
    render(<RcAskPop />);
    expect(await screen.findByText(/DESKTOP-7K2 正在远程本机/)).toBeTruthy();
    expect(screen.queryByText(/想远程这台电脑/)).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(askHide).not.toHaveBeenCalled();
  });

  it("mode=capsule 却没有 host = 一块纯死区，照旧收掉", async () => {
    askState.mockResolvedValue(st({ mode: "capsule" }));
    render(<RcAskPop />);
    await vi.waitFor(() => expect(askHide).toHaveBeenCalled());
  });
});
