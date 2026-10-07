import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RcStatus } from "@/lib/api/rcTypes";
import { useMobileConnectionInfo } from "./useMobileConnectionInfo";

const frames = { visible: true, hasFrame: true, statusText: "", fps: 30, codec: "h264" as const, size: { w: 1920, h: 1080 }, bitrateKbps: 2400, latencyMs: 58, segCapMs: 8, segEncMs: 12, segNetMs: 32, segDecMs: 6, respMs: 42 };
const status = (extra = {}) => ({ session: { id: "a" }, rtt_ms: 36, pong_age_ms: 100, path_kind: "lan", clock_skew_ms: 10, ...extra }) as RcStatus;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("现有状态与视频统计生成真实读数，缺失丢包不当成 0%", () => {
  const current = status();
  const { result } = renderHook(() => useMobileConnectionInfo("a", current, frames));
  expect(result.current).toMatchObject({ state: "connected", label: "流畅", rttMs: 36, path: "局域网直连", lossPermille: 0 });
  expect(result.current.frames).toMatchObject({ fps: 30, latencyMs: 58 });
});
it("中继路径的机器值原样透传给徽章做常驻标注", () => {
  const current = status({ path_kind: "relay" });
  const { result } = renderHook(() => useMobileConnectionInfo("a", current, frames));
  expect(result.current).toMatchObject({ pathKind: "relay", path: "绕中继" });
});
it("没有测量不展示假的零毫秒，不推测连接方式", () => {
  const current = status({ rtt_ms: 0, pong_age_ms: null, path_kind: "" });
  const { result } = renderHook(() => useMobileConnectionInfo("a", current, frames));
  expect(result.current).toMatchObject({ label: "测量中", grade: "unknown", rttMs: 0, path: "", samples: [] });
});
it("时钟校准未就绪时隐藏跨设备延时，但保留本地编码/解码读数", () => {
  const current = status({ clock_skew_ms: 0 });
  const { result } = renderHook(() => useMobileConnectionInfo("a", current, frames));
  expect(result.current.frames).toMatchObject({ latencyMs: 0, segNetMs: 0, segEncMs: 12, segDecMs: 6 });
});
it("恒定 RTT 和恒定心跳年龄的正常轮询不会被当成断线", () => {
  const { result, rerender } = renderHook(({ current }) => useMobileConnectionInfo("a", current, frames), { initialProps: { current: status() } });
  for (let i = 0; i < 10; i++) { act(() => vi.advanceTimersByTime(2000)); rerender({ current: status() }); }
  expect(result.current.state).toBe("connected");
  expect(result.current.samples.length).toBeGreaterThan(2);
});
it("只根据心跳新鲜度识别异常，恢复前不展示旧延时", () => {
  const current = status();
  const { result, rerender } = renderHook(({ data }) => useMobileConnectionInfo("a", data, frames), { initialProps: { data: current } });
  act(() => vi.advanceTimersByTime(7000));
  expect(result.current).toMatchObject({ state: "unstable", rttMs: 0, frames: null });
  act(() => vi.advanceTimersByTime(6000));
  expect(result.current.state).toBe("failed");
  rerender({ data: status({ rtt_ms: 40 }) });
  expect(result.current).toMatchObject({ state: "connected", rttMs: 40 });
});
it("旧对端不提供心跳年龄时不靠恒定 RTT 误判断线", () => {
  const current = status({ pong_age_ms: undefined });
  const { result } = renderHook(() => useMobileConnectionInfo("a", current, frames));
  act(() => vi.advanceTimersByTime(20_000));
  expect(result.current.state).toBe("connected");
});
it("切换会话立即清掉上台设备的数据与趋势", () => {
  const { result, rerender } = renderHook(({ id, current }) => useMobileConnectionInfo(id, current, frames), { initialProps: { id: "a", current: status() } });
  rerender({ id: "b", current: status() });
  expect(result.current).toMatchObject({ rttMs: 0, frames: null, samples: [] });
  rerender({ id: "b", current: status({ session: { id: "b" }, rtt_ms: 15 }) });
  expect(result.current.samples).toHaveLength(1);
  expect(result.current.rttMs).toBe(15);
});
it("隐藏页面停止展示定时器，结束会话无残留", () => {
  const current = status();
  const { result, rerender, unmount } = renderHook(({ id, visible }) => useMobileConnectionInfo(id, current, { ...frames, visible }), { initialProps: { id: "a", visible: true } });
  expect(vi.getTimerCount()).toBe(1);
  rerender({ id: "a", visible: false });
  expect(vi.getTimerCount()).toBe(0);
  expect(result.current.rttMs).toBe(0);
  rerender({ id: "", visible: true });
  expect(vi.getTimerCount()).toBe(0);
  unmount();
});
it("趋势限于最近 60 秒和最多 60 个点，不随时间无限增长", () => {
  const { result, rerender } = renderHook(({ current }) => useMobileConnectionInfo("a", current, frames), { initialProps: { current: status() } });
  for (let i = 0; i < 90; i++) { act(() => vi.advanceTimersByTime(1000)); rerender({ current: status() }); }
  expect(result.current.samples).toHaveLength(60);
  act(() => vi.advanceTimersByTime(61_000));
  expect(result.current.samples).toHaveLength(0);
});
it("静止画面/低帧率不会被当成网络异常", () => {
  const current = status();
  const { result } = renderHook(() => useMobileConnectionInfo("a", current, { ...frames, fps: 1 }));
  expect(result.current.state).toBe("connected");
  expect(result.current.frames?.fps).toBe(1);
});
