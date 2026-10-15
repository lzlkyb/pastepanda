import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionSettings } from "./useSessionSettings";
const api = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("@/lib/api/rcCommands", () => ({ rcApplySetting: api.apply }));
afterEach(() => { cleanup(); api.apply.mockReset(); });
function pending() {
  let resolve!: (value: { status: "accepted" | "unconfirmed"; value: string }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ status: "accepted" | "unconfirmed"; value: string }>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
it("电脑确认前不把画质标记为已生效，拒绝后保留上一确认值", async () => {
  api.apply.mockResolvedValueOnce({ status: "accepted", value: "sharp" });
  const { result } = renderHook(() => useSessionSettings("s"));
  await act(async () => { await result.current.pick("quality", "sharp"); });
  const request = pending(); api.apply.mockReturnValueOnce(request.promise);
  act(() => { void result.current.pick("quality", "smooth"); });
  expect(result.current.confirmed.quality).toBe("sharp");
  expect(result.current.items.quality?.status).toBe("pending");
  await act(async () => { request.reject(new Error("连接中断")); });
  expect(result.current.confirmed.quality).toBe("sharp");
  expect(result.current.items.quality?.status).toBe("error");
});
it("成功回执讲清锁档语义：实名档关自动、auto 恢复自动", async () => {
  api.apply.mockResolvedValueOnce({ status: "accepted", value: "sharp" });
  const { result } = renderHook(() => useSessionSettings("s"));
  await act(async () => { await result.current.pick("quality", "sharp"); });
  expect(result.current.items.quality?.feedback.detail).toContain("电脑自动档已关闭");
  api.apply.mockResolvedValueOnce({ status: "accepted", value: "auto" });
  await act(async () => { await result.current.pick("quality", "auto"); });
  expect(result.current.items.quality?.feedback.detail).toContain("电脑自动档已恢复");
});
it("快速连点忽略迟到的旧结果，不影响另一类设置", async () => {
  const old = pending(), latest = pending();
  api.apply.mockImplementation((_id, key, value) => key === "audio" ? Promise.resolve({ status: "accepted", value: "on" }) : value === "sharp" ? old.promise : latest.promise);
  const { result } = renderHook(() => useSessionSettings("s"));
  await act(async () => { void result.current.pick("quality", "sharp"); });
  act(() => { void result.current.pick("quality", "smooth"); });
  await act(async () => { await result.current.pick("audio", "on"); });
  expect(api.apply).not.toHaveBeenCalledWith("s", "quality", "smooth");
  await act(async () => { old.resolve({ status: "accepted", value: "sharp" }); });
  await act(async () => { latest.resolve({ status: "accepted", value: "smooth" }); });
  expect(result.current.confirmed.quality).toBe("smooth");
  expect(result.current.confirmed.audio).toBe("on");
});
it("旧端未确认不伪造成功，仍可重新发送", async () => {
  api.apply.mockResolvedValue({ status: "unconfirmed", value: "sharp" });
  const { result } = renderHook(() => useSessionSettings("s"));
  await act(async () => { await result.current.pick("quality", "sharp"); });
  expect(result.current.confirmed.quality).toBeNull();
  expect(result.current.items.quality?.status).toBe("unconfirmed");
  await act(async () => { await result.current.retry("quality"); });
  expect(api.apply).toHaveBeenCalledTimes(2);
});
it("重复点击请求中或已确认值不重复发送，失败后允许重试", async () => {
  const request = pending(); api.apply.mockReturnValueOnce(request.promise);
  const { result } = renderHook(() => useSessionSettings("s"));
  await act(async () => { void result.current.pick("quality", "sharp"); });
  act(() => { void result.current.pick("quality", "sharp"); });
  expect(api.apply).toHaveBeenCalledTimes(1);
  await act(async () => { request.resolve({ status: "accepted", value: "sharp" }); });
  await act(async () => { await result.current.pick("quality", "sharp"); });
  expect(api.apply).toHaveBeenCalledTimes(1);
  api.apply.mockRejectedValueOnce(new Error("连接中断"));
  await act(async () => { await result.current.pick("quality", "smooth"); });
  api.apply.mockResolvedValueOnce({ status: "accepted", value: "smooth" });
  await act(async () => { await result.current.retry("quality"); });
  expect(result.current.confirmed.quality).toBe("smooth");
  expect(api.apply).toHaveBeenCalledTimes(3);
});
it("会话换掉后旧回执不能污染新会话", async () => {
  const request = pending(); api.apply.mockReturnValue(request.promise);
  const { result, rerender } = renderHook(({ id }) => useSessionSettings(id), { initialProps: { id: "old" } });
  act(() => { void result.current.pick("quality", "sharp"); });
  rerender({ id: "new" });
  await act(async () => { request.resolve({ status: "accepted", value: "sharp" }); });
  expect(result.current.confirmed.quality).toBeNull();
  expect(result.current.items.quality).toBeUndefined();
});
it("不同设置的失败独立保留，关闭一条摘要不会清掉另一条或面板内结果", async () => {
  api.apply.mockRejectedValue(new Error("网络中断"));
  const { result } = renderHook(() => useSessionSettings("s"));
  await act(async () => { await result.current.pick("quality", "sharp"); await result.current.pick("audio", "on"); });
  expect(result.current.notices.map(item => item.key)).toEqual(["quality", "audio"]);
  act(() => result.current.dismiss("quality"));
  expect(result.current.notices.map(item => item.key)).toEqual(["audio"]);
  expect(result.current.items.quality?.status).toBe("error");
});
it("关闭成功回执不清确认值，工具再打开不重现，其他设置错误仍可恢复", async () => {
  api.apply.mockRejectedValueOnce(new Error("网络中断")).mockResolvedValueOnce({ status: "accepted", value: "on" });
  const { result } = renderHook(() => useSessionSettings("s"));
  await act(async () => { await result.current.pick("quality", "sharp"); await result.current.pick("audio", "on"); });
  act(() => result.current.dismiss("audio"));
  expect(result.current.confirmed.audio).toBe("on");
  expect(result.current.feedbackItems.audio).toBeUndefined();
  expect(result.current.feedbackItems.quality?.status).toBe("error");
  act(() => result.current.dismiss("quality"));
  expect(result.current.feedbackItems.quality?.status).toBe("error");
  expect(result.current.notices).toHaveLength(0);
});
