/**
 * 手机端配对卡的守卫测试 —— 钉住几件「错了也看不出来」的事：
 *
 * ① 出示二维码的内容能被本机的输入解析原样吃回去（`pairQrPayload` 与
 *    `shortCodeFromInput` 是同一个口径的两半）。分叉的表现是：另一台手机
 *    扫到了码，输入框却不认——现场只有两台手机，没有任何日志可看。
 * ② 扫到码 → 输入框自动填上 + 一句人话（不是静默填上，用户不知道发生了什么）。
 * ③ 摄像头被拒 / 扫不到东西时，屏幕上**始终**留着「手动输入」的路
 *    （规则 15.3：失败路径不能只存在于 toast 里）。
 * ④ 出示态默认遮罩、亮码常驻、到期换新、出示时 listen=true——与桌面
 *    `RcA2PairExchange` 同一条流，手机上错了同样看不出来。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairQrPayload } from "./RcShowQr";
import { shortCodeFromClipboard, shortCodeFromInput } from "@/lib/rcShortCode";
import { RcPairCard } from "./RcPairCard";

const rc = vi.hoisted(() => ({
  pinPairBegin: vi.fn(),
  exchangeCheck: vi.fn(),
  shortPairCancel: vi.fn(),
  shortPairCode: vi.fn(),
}));

vi.mock("@/lib/api/rc", () => ({
  rcPinPairBegin: rc.pinPairBegin,
  rcExchangeCheck: rc.exchangeCheck,
  rcShortPairCancel: rc.shortPairCancel,
  rcShortPairCode: rc.shortPairCode,
}));

/** 摄像头由测试驱动：不碰真设备，只让 overlay 按剧本演。 */
const scan = vi.hoisted(() => ({ onFound: null as null | ((t: string) => void), state: "idle" as string }));
vi.mock("./useQrScan", () => ({
  useQrScan: (onFound: (t: string) => void) => {
    scan.onFound = onFound;
    return {
      state: scan.state,
      videoRef: { current: null },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
  },
}));

/** 手机是输入方为主的一端：卡开起来默认就是输入区（出示要显式点）。 */
function renderCard() {
  render(<RcPairCard onPaired={() => {}} />);
}

/** 当前亮着的那枚码（null = 遮着）。 */
function shownDigits(): string | null {
  const el = document.querySelector("[class*='bigCode']");
  return el?.textContent ?? null;
}

beforeEach(() => {
  rc.shortPairCancel.mockResolvedValue(undefined);
  rc.exchangeCheck.mockResolvedValue("waiting");
});

describe("出示二维码与输入解析是同一个口径", () => {
  it("二维码内容（PP-XXXX-XXXX）能被原样解析回 8 位码", () => {
    expect(pairQrPayload("12345678")).toBe("PP-1234-5678");
    expect(shortCodeFromClipboard(pairQrPayload("12345678"))).toBe("12345678");
    expect(shortCodeFromInput(pairQrPayload("12345678"))).toBe("12345678");
    // 对端手敲的形态（8 位连数字 / 4+4）也要认——三条输入路径同一出口
    expect(shortCodeFromInput("12345678")).toBe("12345678");
    expect(shortCodeFromInput("1234 5678")).toBe("12345678");
  });
});

describe("扫一扫", () => {
  beforeEach(() => {
    scan.state = "idle";
    scan.onFound = null;
    rc.shortPairCode.mockReset();
    rc.pinPairBegin.mockReset();
    rc.shortPairCode.mockResolvedValue({ code: "41820620", expires_at: Date.now() + 3 * 60 * 1000 });
    rc.pinPairBegin.mockResolvedValue({ node_id: "p", name: "那台电脑", expires_at: Date.now() + 180000 });
  });

  it("点「扫一扫」开出浮层，且浮层里就有手动输入的路", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /扫一扫/ }));

    expect(screen.getByText("扫一扫")).toBeTruthy();
    // 取景框与取消都必须在（15.3：失败路径与触发同域）
    expect(screen.getByLabelText("摄像头取景")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消，手动输入" })).toBeTruthy();
  });

  it("扫到对方的码 → 输入框自动填上并告诉用户扫到了什么", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /扫一扫/ }));

    // 真机上扫到的就是这个形态：`pairQrPayload` 生成的载荷
    scan.onFound?.(pairQrPayload("87654321"));

    await waitFor(() =>
      expect((screen.getByLabelText("电脑的配对码") as HTMLInputElement).value).toBe("87654321"),
    );
    expect(screen.getByText("已识别对方的配对码，点「开始配对」即可。")).toBeTruthy();
  });

  it("人手敲的 4+4 形态也认（对端把码念给你听的场景）", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /扫一扫/ }));

    scan.onFound?.("8765 4321");

    await waitFor(() =>
      expect((screen.getByLabelText("电脑的配对码") as HTMLInputElement).value).toBe("87654321"),
    );
  });

  it("扫到的不是配对码 → 明说，不静默丢弃", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /扫一扫/ }));

    scan.onFound?.("https://example.com/not-a-pair-code");

    await waitFor(() =>
      expect(screen.getByText("扫到的不是配对码（应是 PP-XXXX-XXXX 或 8 位数字）。")).toBeTruthy(),
    );
    expect((screen.getByLabelText("电脑的配对码") as HTMLInputElement).value).toBe("");
  });

  it("取消扫码保留手动输入草稿，不自动连接", () => {
    renderCard();
    fireEvent.change(screen.getByLabelText("电脑的配对码"), { target: { value: "1234 5678" } });
    fireEvent.click(screen.getByRole("button", { name: /扫一扫/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消，手动输入" }));
    expect((screen.getByLabelText("电脑的配对码") as HTMLInputElement).value).toBe("1234 5678");
    expect(rc.pinPairBegin).not.toHaveBeenCalled();
  });
});

describe("出示态遮罩（设计稿 §3，与桌面同一套规则）", () => {
  beforeEach(() => {
    rc.shortPairCode.mockReset();
    rc.pinPairBegin.mockReset();
    rc.shortPairCode.mockResolvedValue({ code: "41820620", expires_at: Date.now() + 3 * 60 * 1000 });
    rc.pinPairBegin.mockResolvedValue({ node_id: "p", name: "那台电脑", expires_at: Date.now() + 180000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("默认遮罩：进卡看不到码值，点「出示」才向后端取码并亮码", async () => {
    renderCard();
    expect(shownDigits()).toBeNull();
    expect(rc.shortPairCode).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "出示本机配对码" }));
    });

    await waitFor(() => expect(shownDigits()).toBe("4182 0620"));
    // 码来自后端（机器生成），不是用户手敲
    expect(rc.shortPairCode).toHaveBeenCalled();
  });

  it("出示后常驻亮码：不自动收起、有效期内不换码", async () => {
    vi.useFakeTimers();
    renderCard();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "出示本机配对码" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(shownDigits()).toBe("4182 0620");

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    // 2026-10-01 联调拍板：亮码常驻，60 秒到点不收
    expect(shownDigits()).toBe("4182 0620");
    expect(rc.shortPairCode).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("出示方发起会合时 listen=true（写死 false 的表现是点了没反应）", async () => {
    renderCard();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "出示本机配对码" }));
    });
    await waitFor(() => expect(shownDigits()).toBe("4182 0620"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "等待对方连接" }));
    });
    await waitFor(() => expect(rc.pinPairBegin).toHaveBeenCalledWith("41820620", true));
  });

  it("到期静默自动换新（无文字提醒条），新码可见", async () => {
    rc.shortPairCode.mockReset();
    rc.shortPairCode
      .mockResolvedValueOnce({ code: "41820620", expires_at: Date.now() - 1 })
      .mockResolvedValue({ code: "60429183", expires_at: Date.now() + 3 * 60 * 1000 });
    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "出示本机配对码" }));
    });
    // 静默换代：没有提示条（与桌面同款拍板），新码直接亮出
    await waitFor(() => expect(shownDigits()).toBe("6042 9183"));
    expect(screen.queryByText(/已自动换新的/)).toBeNull();
    expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
  });
});
