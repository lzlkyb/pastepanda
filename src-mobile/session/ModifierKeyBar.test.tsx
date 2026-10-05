import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModifierKeyBar } from "./ModifierKeyBar";
afterEach(cleanup);
it("文字提交失败保留草稿，失败反馈在输入区可见", async () => {
  render(<ModifierKeyBar open onHide={vi.fn()} onSendText={() => { throw new Error("input unavailable"); }} pending={[]} onToggleMod={vi.fn()} onFunctionKey={vi.fn()} keyMode="type" onPickKeyMode={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留这段文字" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("保留这段文字");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("未能提交"));
});
it("中文草稿不会逐字发送，明确提交后才发送整串", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  render(<ModifierKeyBar open onHide={vi.fn()} onSendText={send} pending={[]} onToggleMod={vi.fn()} onFunctionKey={vi.fn()} keyMode="type" onPickKeyMode={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "你好，手机端" } });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(send).toHaveBeenCalledWith("你好，手机端");
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(""));
});
it("异步失败保留草稿并允许重试，在发送结束前不能重复提交", async () => {
  let reject!: (error: Error) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  render(<ModifierKeyBar open onHide={vi.fn()} onSendText={send} pending={[]} onToggleMod={vi.fn()} onFunctionKey={vi.fn()} keyMode="type" onPickKeyMode={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留草稿" } });
  const form = screen.getByRole("textbox").closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(send).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("保留草稿");
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert").textContent).toContain("未能提交");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(""));
  expect(send).toHaveBeenCalledTimes(2);
});
it("等待发送期间新写的草稿不会被前一次成功清空", async () => {
  let resolve!: () => void;
  const send = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  render(<ModifierKeyBar open onHide={vi.fn()} onSendText={send} pending={[]} onToggleMod={vi.fn()} onFunctionKey={vi.fn()} keyMode="type" onPickKeyMode={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "第一段" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "第二段" } });
  await act(async () => resolve());
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("第二段");
});
it("键盘收起再展开保留未发送草稿", () => {
  const props = { onHide: vi.fn(), onSendText: vi.fn(), pending: [], onToggleMod: vi.fn(), onFunctionKey: vi.fn(), keyMode: "type" as const, onPickKeyMode: vi.fn() };
  const view = render(<ModifierKeyBar {...props} open />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "未发送" } });
  view.rerender(<ModifierKeyBar {...props} open={false} />);
  view.rerender(<ModifierKeyBar {...props} open />);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("未发送");
});
