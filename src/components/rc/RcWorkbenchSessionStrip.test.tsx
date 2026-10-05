import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RcWorkbenchSessionStrip } from "./RcWorkbenchSessionStrip";

describe("工具页会话状态条", () => {
  it("等待取消有忙碌反馈、阻止重复操作，失败后允许重试", async () => {
    let finish!: (ok: boolean) => void;
    const onEnd = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const toast = vi.fn();
    render(<RcWorkbenchSessionStrip peerName="工作电脑" pending capability="control" busy={false} onEnd={onEnd} onReturn={vi.fn()} toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: "取消申请" }));
    const busyButton = screen.getByRole("button", { name: "处理中…" }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    fireEvent.click(busyButton);
    expect(onEnd).toHaveBeenCalledTimes(1);
    finish(false);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("取消申请失败"), "error"));
    expect((screen.getByRole("button", { name: "取消申请" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("被控仅查看时说明实际能力，返回入口不结束会话，异常会提示", async () => {
    const onEnd = vi.fn().mockRejectedValue(new Error("offline"));
    const onReturn = vi.fn();
    const toast = vi.fn();
    render(<RcWorkbenchSessionStrip peerName="Pixel" pending={false} capability="view" busy={false} onEnd={onEnd} onReturn={onReturn} toast={toast} />);
    expect(screen.getByText("Pixel 正在远程查看本机")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回会话" }));
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "结束会话" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("结束会话失败，请重试", "error"));
  });
});
