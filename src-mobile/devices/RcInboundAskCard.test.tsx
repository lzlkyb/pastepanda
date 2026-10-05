import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RcInboundKnock } from "@/lib/api/rc";
import { RcInboundAskCard } from "./RcInboundAskCard";

afterEach(cleanup);
const knock: RcInboundKnock = { peer: "node-abc", peer_name: "DESKTOP", display_name: "我的电脑", capability: "control", first_seen_ms: 0 };

it.each(["control", "view"] as const)("手机不承诺未实现的 %s 被控能力", capability => {
  render(<RcInboundAskCard knock={{ ...knock, capability }} busy={false} onDeny={vi.fn()} />);
  expect(screen.getByText(/手机暂不支持被远程观看或控制/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /允许/ })).toBeNull();
});

it("拒绝失败在卡片显示反馈并解除禁用，可重新提交", async () => {
  const deny = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<RcInboundAskCard knock={knock} busy={false} onDeny={deny} />);
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  await screen.findByText("未能拒绝请求，请重试。");
  expect((screen.getByRole("button", { name: "拒绝" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  await waitFor(() => expect(deny).toHaveBeenCalledTimes(2));
  expect(deny).toHaveBeenLastCalledWith("node-abc");
});

it("异步抛错同样解除禁用，在途操作不重复发送", async () => {
  let reject!: (error: Error) => void;
  const deny = vi.fn(() => new Promise<boolean>((_, fail) => { reject = fail; }));
  render(<RcInboundAskCard knock={knock} busy={false} onDeny={deny} />);
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  fireEvent.click(screen.getByRole("button", { name: "正在拒绝…" }));
  expect(deny).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("offline")));
  expect((screen.getByRole("button", { name: "拒绝" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText("未能拒绝请求，请重试。")).toBeTruthy();
});

it("显示名缺失回落设备名，全局忙碌时不发送请求", () => {
  const deny = vi.fn();
  render(<RcInboundAskCard knock={{ ...knock, display_name: "" }} busy onDeny={deny} />);
  expect(screen.getByText("DESKTOP 请求连接这台手机")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  expect(deny).not.toHaveBeenCalled();
});
