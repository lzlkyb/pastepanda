/**
 * RcPrivPill 守卫单测（丙-②，2026-09-30）。
 *
 * 只钉两件在代码审查里看不出来的事：
 * 1. 「结束」必须真打到 `rc_end_session`——这颗键是这条指示的全部可操作性，
 *    它打空了就退化成「告诉你有人在看着你，但你什么也做不了」（对标 §6.2 的反面）。
 * 2. 失败要就地换成那行文字（独立 webview 没有 toast，§15.1 触发与反馈同域），
 *    并且留一颗能再点的重试。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RcPrivPill } from "./RcPrivPill";
import { rcEndSession } from "@/lib/api/rcCommands";
import type { RcAskHost } from "@/lib/api/rc";

vi.mock("@/lib/api/rcCommands", () => ({
  rcEndSession: vi.fn().mockResolvedValue(undefined),
}));

const end = vi.mocked(rcEndSession);

const row = (over: Partial<RcAskHost> = {}): RcAskHost => ({
  peer: "9f2c",
  display_name: "DESKTOP-7K2",
  capability: "control",
  started_ms: Date.now() - 161_000,
  ...over,
});

beforeEach(() => {
  end.mockReset().mockResolvedValue(undefined);
});

describe("RcPrivPill", () => {
  it("说得出「谁在远程 + 拿到什么能力 + 多久了」", async () => {
    render(<RcPrivPill host={row()} />);
    expect(await screen.findByText("DESKTOP-7K2 正在远程本机")).toBeTruthy();
    expect(screen.getByText("可控")).toBeTruthy();
    expect(screen.getByText(/^0?2:4\d$/)).toBeTruthy();
  });

  it("只看屏幕的会话不写「可控」（措辞夸大等于把授权说漏）", async () => {
    render(<RcPrivPill host={row({ capability: "view" })} />);
    expect(await screen.findByText("只看")).toBeTruthy();
    expect(screen.queryByText("可控")).toBeNull();
  });

  it("「结束」直接终止会话，不摆二次确认（被看着时每多一次点击都是暴露）", async () => {
    render(<RcPrivPill host={row()} />);
    const btn = await screen.findByRole("button", { name: "结束" });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("结束失败：那句话顶掉主语，键变成可重试的「重试」", async () => {
    end.mockRejectedValueOnce("链路已断");
    render(<RcPrivPill host={row()} />);
    const btn = await screen.findByRole("button", { name: "结束" });
    await act(async () => {
      fireEvent.click(btn);
    });
    const retry = await screen.findByRole("button", { name: "重试" });
    expect(screen.getByText(/没能结束/).textContent).toContain("链路已断");
    expect(screen.queryByText("DESKTOP-7K2 正在远程本机")).toBeNull();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(end).toHaveBeenCalledTimes(2);
  });
});
