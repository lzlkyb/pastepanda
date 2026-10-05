import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { rcSendInput } from "@/lib/api/rcCommands";
import { sendEvent, useRcMobileInput } from "./useRcMobileInput";
vi.mock("@/lib/api/rcCommands", () => ({ rcSendInput: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => vi.clearAllMocks());
it("显式文本提交把异步发送失败反馈给调用者，只看时拒绝提交", async () => {
  const at = { current: 0 };
  const { result, rerender } = renderHook(({ allowed }) => useRcMobileInput({ canControl: allowed, hasFrame: true, canvasRef: { current: null }, contentRef: { current: { w: 1, h: 1 } }, lastInputAt: at }), { initialProps: { allowed: true } });
  vi.mocked(rcSendInput).mockRejectedValueOnce(new Error("offline"));
  await expect(result.current.submitText("草稿")).rejects.toThrow("offline");
  expect(at.current).toBe(0);
  await expect(result.current.submitText("重试")).resolves.toBeUndefined();
  expect(at.current).toBeGreaterThan(0);
  vi.mocked(rcSendInput).mockClear();
  rerender({ allowed: false });
  await expect(result.current.submitText("只看")).rejects.toThrow("无法输入");
  expect(rcSendInput).not.toHaveBeenCalled();
});
it("点击/键盘/文本/滚轮统一记录输入时间，移动/松手/设置不污染样本", () => {
  const at = { current: 0 };
  sendEvent({ kind: "mouse_move", x: 1, y: 1 }, at);
  sendEvent({ kind: "set_quality", quality: "auto" }, at);
  expect(at.current).toBe(0);
  sendEvent({ kind: "mouse_button", x: 1, y: 1, button: 1, down: true }, at);
  expect(at.current).toBeGreaterThan(0);
  for (const event of [{ kind: "key", vk: 13, down: true }, { kind: "text", text: "a" }, { kind: "wheel", x: 1, y: 1, delta: -120 }] as const) {
    at.current = 0; sendEvent(event, at); expect(at.current).toBeGreaterThan(0);
  }
  at.current = 123;
  sendEvent({ kind: "key", vk: 13, down: false }, at);
  expect(at.current).toBe(123);
});
it("失败的发送不生成操作响应样本", async () => {
  const at = { current: 0 };
  vi.mocked(rcSendInput).mockRejectedValueOnce(new Error("offline"));
  sendEvent({ kind: "text", text: "a" }, at);
  await Promise.resolve();
  expect(at.current).toBe(0);
});
it("hook 的发送也经过相同收口，只看模式不更新输入时间", () => {
  const at = { current: 0 };
  const { result, rerender } = renderHook(({ allowed }) => useRcMobileInput({ canControl: allowed, hasFrame: true, canvasRef: { current: null }, contentRef: { current: { w: 1, h: 1 } }, lastInputAt: at }), { initialProps: { allowed: true } });
  act(() => result.current.sendText("a"));
  expect(at.current).toBeGreaterThan(0);
  rerender({ allowed: false }); at.current = 0;
  act(() => result.current.sendText("b"));
  expect(at.current).toBe(0);
});
it("守卫：手机 hook 不允许新增绕过统一发送入口的调用点", () => {
  const source = readFileSync("src-mobile/session/useRcMobileInput.ts", "utf8").split("export function useRcMobileInput")[1];
  expect(source.match(/sendEvent\(/g)).toHaveLength(1);
  expect(source).not.toContain("rcSendInput(");
});

it("发送失败翻转健康位、恢复自动翻回、再次失败重新点亮（横幅依据）", async () => {
  const { result } = renderHook(() => useRcMobileInput({ canControl: true, hasFrame: true, canvasRef: { current: null }, contentRef: { current: { w: 1, h: 1 } } }));
  expect(result.current.sendFailed).toBe(false);
  vi.mocked(rcSendInput).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { result.current.sendRaw({ kind: "set_quality", quality: "auto" }); await Promise.resolve(); });
  expect(result.current.sendFailed).toBe(true);
  await act(async () => { result.current.sendRaw({ kind: "set_quality", quality: "auto" }); await Promise.resolve(); });
  expect(result.current.sendFailed).toBe(false);
  vi.mocked(rcSendInput).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { result.current.sendRaw({ kind: "set_quality", quality: "auto" }); await Promise.resolve(); });
  expect(result.current.sendFailed).toBe(true);
});
it("IME 自动上屏失败没有其他反馈出口，必须翻转健康位", async () => {
  const { result } = renderHook(() => useRcMobileInput({ canControl: true, hasFrame: true, canvasRef: { current: null }, contentRef: { current: { w: 1, h: 1 } } }));
  vi.mocked(rcSendInput).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { result.current.sendText("你好"); await Promise.resolve(); });
  expect(result.current.sendFailed).toBe(true);
});
