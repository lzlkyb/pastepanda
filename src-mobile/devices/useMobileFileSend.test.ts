import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useMobileFileSend } from "./useMobileFileSend";

const send = vi.hoisted(() => vi.fn());
vi.mock("./rcSendFiles", () => ({ sendFilesToPeer: send }));
beforeEach(() => send.mockReset());

it("上传中防重复发送；成功后可继续发送下一批", async () => {
  let finish!: (value: unknown) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  send.mockResolvedValue([{ ok: true, name: "b.txt" }]);
  const { result } = renderHook(() => useMobileFileSend());
  const files = [new File(["a"], "a.txt")];
  let pending!: Promise<void>;
  act(() => { pending = result.current.send("pc", "电脑", files); });
  expect(result.current.sending).toBe(true);
  await act(() => result.current.send("pc", "电脑", files));
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { finish([{ ok: true, name: "a.txt" }]); await pending; });
  expect(result.current.sending).toBe(false);
  expect(result.current.note).toMatch(/等.*确认/);
  await act(() => result.current.send("pc", "电脑", files));
  expect(send).toHaveBeenCalledTimes(2);
});

it("部分文件失败不会显示整批成功，失败也会传到应用级提示", async () => {
  send.mockResolvedValue([{ ok: true, name: "a.txt" }, { ok: false, name: "b.txt", err: "denied" }]);
  const status = vi.fn();
  const { result } = renderHook(() => useMobileFileSend(status));
  await act(() => result.current.send("pc", "电脑", [new File(["a"], "a.txt"), new File(["b"], "b.txt")]));
  expect(result.current.note).toBeNull();
  expect(result.current.error).toMatch(/b.txt/);
  expect(result.current.error).toMatch(/1 个文件已提交，1 个未完成/);
  expect(result.current.partial).toBe(true);
  expect(result.current.error).not.toContain("已发送");
  expect(status).toHaveBeenLastCalledWith(expect.stringContaining("b.txt"), true);
  expect(result.current.sending).toBe(false);
  act(() => result.current.dismissError());
  expect(result.current.error).toBeNull();
  expect(status).toHaveBeenLastCalledWith(null, false);
});

it("取消传入本批信号，保留已提交状态，下一批使用新信号", async () => {
  let finish!: (value: unknown) => void;
  send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useMobileFileSend());
  let pending!: Promise<void>;
  act(() => { pending = result.current.send("pc", "电脑", [new File(["a"], "a.txt")]); });
  const signal = send.mock.calls[0][3] as AbortSignal;
  act(() => result.current.cancel());
  expect(signal.aborted).toBe(true);
  expect(result.current.canceling).toBe(true);
  await act(async () => { finish([{ ok: true, name: "a.txt" }]); await pending; });
  expect(result.current.note).toMatch(/1 个文件已提交/);
  send.mockResolvedValueOnce([{ ok: true, name: "b.txt" }]);
  await act(() => result.current.send("pc", "电脑", [new File(["b"], "b.txt")]));
  expect((send.mock.calls[1][3] as AbortSignal).aborted).toBe(false);
});
