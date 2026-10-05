/**
 * 配对码显示 / 读秒的守卫测试（2026-09-29 设计稿 §0-§4，10-01 联调修订）。
 *
 * 钉住的四件事在产品上「错了也看不出来」：
 * ① **进卡片即亮码**（2026-10-01 用户拍板：默认常驻显示，不再先点「出示」；
 *    「收起」按钮兜隐私）；
 * ② **收起只收回显示，不清会话**——收起了还必须是同一枚码（用户 alt-tab
 *    去手机拿码回来点「重新出示」，看到的不能是一枚新码，否则已发出去的那枚作废）；
 * ③ **二维码随码常驻**——手机「扫一扫」扫的就是它，电脑侧漏了它手机就没东西可扫
 *    （2026-10-01 联调实测踩过）；
 * ④ **出示方的码来自后端**（均匀随机），不留给用户手敲——手敲的生日/连号
 *    实际熵远低于 27 bit，会合通道的认证强度就不成立。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcA2PairExchange } from "./RcA2PairExchange";

const rc = vi.hoisted(() => ({
  exchangeCheck: vi.fn(),
  pinPairBegin: vi.fn(),
  shortPairCancel: vi.fn(async () => undefined),
  shortPairCode: vi.fn(),
}));
const clipboard = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/rc", () => ({
  rcExchangeCheck: rc.exchangeCheck,
  rcPinPairBegin: rc.pinPairBegin,
  rcShortPairCancel: rc.shortPairCancel,
  rcShortPairCode: rc.shortPairCode,
}));
vi.mock("@/lib/api", () => ({ readClipboardText: clipboard }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));

/** 未来 3 分钟过期（对齐设计稿 §0：会合码 3 分钟）。 */
const EXPIRES_AT = Date.now() + 3 * 60 * 1000;

function renderPane() {
  const api = {
    identity: { node_id: "local", device_name: "本机", fingerprint: "3F9A·21C0" },
    refreshTargets: vi.fn(async () => {}),
  } as unknown as UseRc;
  render(<RcA2PairExchange rc={api} toast={vi.fn()} />);
}

/** 当前亮着的那枚码（null = 遮着）。 */
function shownDigits(): string | null {
  const el = document.querySelector("[class*='pairDigits']");
  return el?.textContent ?? null;
}

describe("配对码遮罩（设计稿 §1）", () => {
  beforeEach(() => {
    clipboard.mockResolvedValue("");
    rc.exchangeCheck.mockResolvedValue("waiting");
    // 🔴 必须清计数：这几个 vi.fn 跨用例共享，`toHaveBeenCalledTimes` 是绝对值，
    // 不清就会读到上一个用例留下的调用记录（表现为「明明只取一次码却报三次」）。
    rc.shortPairCode.mockReset();
    rc.pinPairBegin.mockReset();
    rc.shortPairCode.mockResolvedValue({ code: "41820620", expires_at: EXPIRES_AT });
    rc.pinPairBegin.mockResolvedValue({
      node_id: "peer-1",
      name: "那台手机",
      expires_at: EXPIRES_AT,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("进卡片即亮码；二维码默认藏，点了在弹框里展示", async () => {
    vi.useFakeTimers();
    renderPane();
    // 不点任何按钮：挂载即取码亮出
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(shownDigits()).toBe("4182 0620");
    expect(rc.shortPairCode).toHaveBeenCalledTimes(1);
    // 二维码默认不在 DOM（jsdom 画不了 canvas，只钉「入口在、弹框开关走」）
    expect(document.querySelector("canvas[aria-label='配对码二维码']")).toBeNull();
    expect(screen.getByRole("button", { name: "二维码" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "出示" })).toBeNull();

    // 点「二维码」→ 弹框出现（含画布与明文码），Esc / 关闭都能收
    fireEvent.click(screen.getByRole("button", { name: "二维码" }));
    const dialog = screen.getByRole("dialog", { name: "配对码二维码" });
    expect(dialog.querySelector("canvas[aria-label='配对码二维码']")).toBeTruthy();
    // 明文码在弹框里再出现一份（码条上那一份仍在）
    expect(dialog.textContent).toContain("4182 0620");

    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("dialog", { name: "配对码二维码" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "二维码" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "配对码二维码" })).toBeNull();
    // 亮码不受弹框开关影响
    expect(shownDigits()).toBe("4182 0620");
  });

  it("亮码常驻：收起计时不存在，60 秒后仍是同一枚码且没再取新码", async () => {
    vi.useFakeTimers();
    renderPane();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(shownDigits()).toBe("4182 0620");

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(shownDigits()).toBe("4182 0620");
    // 亮码期间绝不另取新码（有效期内复用同一枚）
    expect(rc.shortPairCode).toHaveBeenCalledTimes(1);
  });

  it("用户点「收起」立刻收回、再出示还是同一枚，全程不换码", async () => {
    vi.useFakeTimers();
    renderPane();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(shownDigits()).toBe("4182 0620");

    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(shownDigits()).toBeNull();
    expect(rc.shortPairCode).toHaveBeenCalledTimes(1);

    // 再出示：同一枚未过期的码，不重新取
    fireEvent.click(screen.getByRole("button", { name: "出示" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(shownDigits()).toBe("4182 0620");
    expect(rc.shortPairCode).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("亮码即自动监听：不点任何按钮就以 listen=true 发起（2026-10-03 教训）", async () => {
    vi.useFakeTimers();
    renderPane();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(shownDigits()).toBe("4182 0620");
    // 过去：扫码后还得再点「我出示这枚码」才开始监听，扫码方永远干等。
    // 现在：码一亮就自动挂上监听，按钮已删除。
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(rc.pinPairBegin).toHaveBeenCalledWith("41820620", true);
    expect(screen.queryByRole("button", { name: "我出示这枚码" })).toBeNull();
    vi.useRealTimers();
  });

  it("输入方填对方那枚码发起，角色固定 listen=false", async () => {
    renderPane();
    fireEvent.change(screen.getByLabelText("对方的配对码"), { target: { value: "87654321" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "对方给我这枚码" }));
    });

    await waitFor(() => expect(rc.pinPairBegin).toHaveBeenCalledWith("87654321", false));
  });

  it("拨号失败回到 idle 后，亮着的码自动重新挂监听（2026-10-03 教训收尾）", async () => {
    // 第一次 = 亮码自动监听；第二次 = 手动拨号且失败；第三次 = 回 idle 后自动重挂。
    rc.pinPairBegin
      .mockResolvedValueOnce({ node_id: "peer-1", name: "那台手机", expires_at: EXPIRES_AT })
      .mockRejectedValueOnce(new Error("对方未在监听"));
    renderPane();
    await waitFor(() => expect(rc.pinPairBegin).toHaveBeenCalledWith("41820620", true));
    expect(rc.pinPairBegin).toHaveBeenCalledTimes(1);

    // 拨号失败 → error 态（码仍亮着）。监听成功后按钮文案是「等待中」，两种都要认。
    fireEvent.change(screen.getByLabelText("对方的配对码"), { target: { value: "87654321" } });
    fireEvent.click(screen.getByRole("button", { name: /对方给我这枚码|等待中/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(rc.pinPairBegin).toHaveBeenCalledTimes(2);

    // 改输入回到 idle：监听自己回来——否则码只是「摆着」，扫码方继续干等
    fireEvent.change(screen.getByLabelText("对方的配对码"), { target: { value: "8765432" } });
    await waitFor(() => expect(rc.pinPairBegin).toHaveBeenCalledTimes(3));
    expect(rc.pinPairBegin).toHaveBeenLastCalledWith("41820620", true);
  });
});

describe("到期换新（设计稿 §4）", () => {
  beforeEach(() => {
    clipboard.mockResolvedValue("");
    rc.exchangeCheck.mockResolvedValue("waiting");
    rc.shortPairCode.mockReset();
    rc.pinPairBegin.mockReset();
    rc.pinPairBegin.mockResolvedValue({ node_id: "p", name: "n", expires_at: Date.now() + 180000 });
  });

  /** 出示一枚「已经过期」的码 → 组件应立即换新并提示。返回即已换过。 */
  async function revealExpiredCode() {
    rc.shortPairCode.mockReset();
    rc.shortPairCode
      .mockResolvedValueOnce({ code: "41820620", expires_at: Date.now() - 1 })
      .mockResolvedValue({ code: "60429183", expires_at: Date.now() + 3 * 60 * 1000 });
    // 挂载即自动取码（2026-10-01 起默认亮码），不需要点「出示」
    renderPane();
  }

  it("取到一枚已过期的码 → 静默自动换新（无文字提醒条），新码直接可见", async () => {
    await revealExpiredCode();

    // 静默换代：没有「知道了」提示条（2026-10-01 用户拍板），只有新码值
    expect(screen.queryByText(/已自动换新的/)).toBeNull();
    expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
    // 换代不动显示态：这里是亮码态，所以新码直接可见——
    // 用户正看着屏，把新码藏起来比让他多等更糟。
    await waitFor(() => expect(shownDigits()).toBe("6042 9183"));
    expect(rc.shortPairCode.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("换新后收起再出示，看到的是新码（旧码已作废）", async () => {
    await revealExpiredCode();
    await waitFor(() => expect(shownDigits()).toBe("6042 9183"));

    // 收起 → 遮罩态 → 再出示：仍是同一枚新码（不再回退到旧码）
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    await waitFor(() => expect(shownDigits()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "出示" }));
    // 关键断言：回来的是新码，不是那枚已作废的旧码
    await waitFor(() => expect(shownDigits()).toBe("6042 9183"));
  });
});
