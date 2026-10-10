import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RcReceivedFileActions } from "./RcReceivedFileActions";
const action = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/rcFile", () => ({ mobileReceivedFileAction: action }));
beforeEach(() => { action.mockReset(); });
it("只传任务身份，分享不声称送达，导出取消保留源文件", async () => {
  action.mockResolvedValueOnce({ status: "opened" }).mockResolvedValueOnce({ status: "cancelled" });
  render(<RcReceivedFileActions taskId="received-1" />);
  fireEvent.click(screen.getByRole("button", { name: "分享" }));
  await screen.findByText("已打开系统分享面板");
  expect(action).toHaveBeenCalledWith("received-1", "share");
  fireEvent.click(screen.getByRole("button", { name: "导出" }));
  await screen.findByText("已取消导出，原文件仍保留");
  expect(action).toHaveBeenCalledWith("received-1", "export");
});
it("拒绝或失效有就地可恢复的错误，双击只发一次", async () => {
  let fail!: (e: unknown) => void;
  action.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  render(<RcReceivedFileActions taskId="received-1" />);
  fireEvent.click(screen.getByRole("button", { name: "打开" }));
  fireEvent.click(screen.getByRole("button", { name: "分享" }));
  expect(action).toHaveBeenCalledTimes(1);
  fail("没有可打开此文件的应用，请使用分享或导出");
  await screen.findByText("文件操作未能完成");
  await waitFor(() => expect((screen.getByRole("button", { name: "分享" }) as HTMLButtonElement).disabled).toBe(false));
});
