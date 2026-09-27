import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcA2PairExchange } from "./RcA2PairExchange";

const shortPairCode = vi.hoisted(() => vi.fn());
const shortPairBegin = vi.hoisted(() => vi.fn());
const shortPairCancel = vi.hoisted(() => vi.fn(async () => undefined));
const exchangeCheck = vi.hoisted(() => vi.fn());
const readClipboard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/rc", () => ({
  rcShortPairCode: shortPairCode,
  rcShortPairBegin: shortPairBegin,
  rcShortPairCancel: shortPairCancel,
  rcExchangeCheck: exchangeCheck,
}));
vi.mock("@/lib/api", () => ({ readClipboardText: readClipboard }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));

describe("RcA2PairExchange", () => {
  it("默认显示八位码，识别剪贴板后仍由用户确认配对", async () => {
    shortPairCode.mockResolvedValue({ code: "12345678", expires_at: Date.now() + 60_000 });
    shortPairBegin.mockResolvedValue({ node_id: "peer", name: "对方", expires_at: Date.now() + 60_000 });
    exchangeCheck.mockResolvedValue("waiting");
    readClipboard.mockResolvedValue("PP-8765-4321");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const refreshTargets = vi.fn();
    const toast = vi.fn();
    const rc = {
      identity: { node_id: "local", device_name: "本机" },
      refreshTargets,
    } as unknown as UseRc;

    render(<RcA2PairExchange rc={rc} toast={toast} />);
    // 🔴 码值 span 不能挂 aria-label（generic 禁止命名，rcA11yNames 守卫）——
    // 名字挂在整行 group 上，码值文本在 group 内断言。
    await waitFor(() =>
      expect(within(screen.getByRole("group", { name: "我的配对码" })).getByText("1234 5678")).toBeTruthy(),
    );
    await waitFor(() => expect((screen.getByLabelText("对方的配对码") as HTMLInputElement).value).toBe("8765 4321"));
    expect(shortPairBegin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("PP-1234-5678"));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(shortPairBegin).toHaveBeenCalledWith("12345678", "87654321"));
    await waitFor(() => expect(exchangeCheck).toHaveBeenCalledWith("peer"));
    expect(refreshTargets).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("已与"), "success");
  });

  it("等待另一端时可取消，不必等短码到期", async () => {
    shortPairCode.mockResolvedValue({ code: "12345678", expires_at: Date.now() + 60_000 });
    shortPairBegin.mockReturnValue(new Promise(() => {}));
    readClipboard.mockResolvedValue("");
    shortPairCancel.mockClear();
    const rc = {
      identity: { node_id: "local", device_name: "本机" },
      refreshTargets: vi.fn(),
    } as unknown as UseRc;
    render(<RcA2PairExchange rc={rc} toast={vi.fn()} />);
    await waitFor(() =>
      expect(within(screen.getByRole("group", { name: "我的配对码" })).getByText("1234 5678")).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("对方的配对码"), { target: { value: "87654321" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(shortPairCancel).toHaveBeenCalled());
  });
});
