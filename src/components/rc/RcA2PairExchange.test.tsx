import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcA2PairExchange } from "./RcA2PairExchange";

const exchangeBegin = vi.hoisted(() => vi.fn());
const exchangeCheck = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/rc", () => ({ rcExchangeBegin: exchangeBegin, rcExchangeCheck: exchangeCheck }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));

describe("RcA2PairExchange", () => {
  it("粘贴单方的码后显示等待，只有后端确认双方交换才显示配对成功", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    exchangeBegin.mockResolvedValue({ node_id: "peer", name: "对方", expires_at: Date.now() + 60_000 });
    exchangeCheck.mockResolvedValue("waiting");
    const refreshTargets = vi.fn();
    const toast = vi.fn();
    const rc = {
      identity: { node_id: "local", device_name: "本机" },
      createInvite: vi.fn(async () => ({ code: "我的码", expires_at: Date.now() + 60_000 })),
      refreshTargets,
    } as unknown as UseRc;

    render(<RcA2PairExchange rc={rc} enabled toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: "生成并复制配对码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("我的码"));
    fireEvent.click(screen.getByRole("button", { name: "粘贴对方的配对码" }));
    fireEvent.change(screen.getByLabelText("对方发来的码"), { target: { value: "对方的码" } });
    fireEvent.click(screen.getByRole("button", { name: "确认交换" }));
    await waitFor(() => expect(exchangeCheck).toHaveBeenCalledWith("peer"));
    expect(screen.getByText(/等待对方也粘贴你的码/)).toBeTruthy();
    expect(refreshTargets).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("已与"), "success");
  });
});
