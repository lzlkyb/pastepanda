import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { RcFileView } from "@/hooks/useRcFile";
import { SessionFileRequests } from "./SessionFileRequests";

const dir = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/rcFile", () => ({ rcFileDefaultDir: dir }));
beforeEach(() => dir.mockReset());
function fileView() {
  return { asks: [{ id: "ask", peer: "pc", peer_name: "工作电脑", kind: "push", name: "报告.pdf", size: 12, first_seen_ms: Date.now() }], busy: false, error: null, respond: vi.fn(() => new Promise<boolean>(() => {})) } as unknown as RcFileView;
}
it("接收和拒绝反馈留在会话面板，拒绝不会让接受显示处理中", async () => {
  dir.mockResolvedValue("/receive");
  const file = fileView();
  const view = render(<SessionFileRequests file={file} open={false} onClose={vi.fn()} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<SessionFileRequests file={file} open onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "接受" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  expect(file.respond).toHaveBeenCalledWith("ask", null);
  expect(screen.getByRole("button", { name: "正在拒绝…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "接受" })).toBeDisabled();
});
it("接收位置失败在会话中可重试，已过期的请求禁止响应", async () => {
  dir.mockRejectedValueOnce("无法获取接收位置").mockResolvedValue("/receive");
  const file = fileView();
  file.asks[0].first_seen_ms = Date.now() - 61_000;
  render(<SessionFileRequests file={file} open onClose={vi.fn()} />);
  expect(await screen.findByText("无法获取接收位置")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(dir).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/请求已过期/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "接受" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
});

it("最后一条请求成功后返回画面，响应失败仍留在面板", async () => {
  dir.mockResolvedValue("/receive");
  const file = fileView();
  vi.mocked(file.respond).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const close = vi.fn();
  render(<SessionFileRequests file={file} open onClose={close} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "接受" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "接受" }));
  await waitFor(() => expect(file.respond).toHaveBeenCalledTimes(1));
  expect(close).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "接受" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "接受" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
