import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionClipboard } from "./useSessionClipboard";
const api = vi.hoisted(() => ({ push: vi.fn(), pull: vi.fn() }));
vi.mock("@/lib/api/rc", () => ({ rcPushClipboard: api.push, rcPullClipboard: api.pull }));
const read = vi.fn(), write = vi.fn();
beforeEach(() => {
  api.push.mockReset(); api.pull.mockReset(); read.mockReset(); write.mockReset();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: read, writeText: write } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("失败保留在面板，不泄露原始错误；重试沿用原操作并恢复成功", async () => {
  vi.useFakeTimers();
  read.mockResolvedValue("hello");
  api.push.mockRejectedValueOnce(new Error("TypeError: token=secret"));
  api.push.mockResolvedValueOnce(undefined);
  const { result } = renderHook(() => useSessionClipboard());
  await act(() => result.current.push());
  expect(result.current.clipOpen).toBe(true);
  expect(result.current.feedback?.tone).toBe("error");
  expect(JSON.stringify(result.current.feedback)).not.toMatch(/secret|TypeError/);
  act(() => vi.advanceTimersByTime(30000));
  expect(result.current.feedback?.tone).toBe("error");
  await act(() => result.current.retry());
  expect(api.push).toHaveBeenCalledTimes(2);
  expect(result.current.feedback?.tone).toBe("success");
});
it("处理中阻止重复操作，空内容与无结果区分", async () => {
  let finish!: (value: string | null) => void;
  api.pull.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useSessionClipboard());
  let pending!: Promise<void>;
  act(() => { pending = result.current.pull(); });
  await act(() => result.current.push());
  expect(read).not.toHaveBeenCalled();
  expect(result.current.feedback?.tone).toBe("pending");
  await act(async () => { finish(null); await pending; });
  expect(result.current.feedback?.tone).toBe("error");
  api.pull.mockResolvedValueOnce("");
  await act(() => result.current.retry());
  expect(result.current.feedback?.tone).toBe("info");
  expect(write).not.toHaveBeenCalled();
});
it("离开会话后不再写手机剪贴板", async () => {
  let finish!: (value: string) => void;
  api.pull.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, unmount } = renderHook(() => useSessionClipboard());
  let pending!: Promise<void>;
  act(() => { pending = result.current.pull(); });
  unmount();
  finish("sensitive text"); await pending;
  expect(write).not.toHaveBeenCalled();
});
