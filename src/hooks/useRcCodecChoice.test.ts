// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rcApplySetting, type RcSettingResult } from "@/lib/api/rc";
import { useRcCodecChoice } from "./useRcCodecChoice";
vi.mock("@/lib/api/rc", () => ({ rcApplySetting: vi.fn() }));
const accepted = { status: "accepted", value: "av1" } as const;
function setup(overrides = {}) {
  return { sessionId: "owned-a", peerHevc: true, peerAv1: true, actualCodec: "h264",
    quality: "balanced", connected: true, mac: true, onQuality: vi.fn(), onStatus: vi.fn(), ...overrides };
}
function deferred() {
  let resolve!: (v: RcSettingResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<RcSettingResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.mocked(rcApplySetting).mockReset().mockResolvedValue(accepted); });
describe("远程会话编码选择", () => {
  it("只展示对方上报的 HEVC / AV1 能力；禁用时不发请求", async () => {
    const p = setup({ peerHevc: undefined, peerAv1: false, connected: false });
    const h = renderHook(() => useRcCodecChoice(p));
    expect(h.result.current.options.map(o => o.key)).toEqual(["h264", "jpeg"]);
    await act(() => h.result.current.pick("av1"));
    expect(rcApplySetting).not.toHaveBeenCalled();
  });
  it("请求未完成时锁住重复操作，接收编码只来自真实帧", async () => {
    const p = setup(); const d = deferred();
    vi.mocked(rcApplySetting).mockReturnValue(d.promise);
    const h = renderHook(() => useRcCodecChoice(p));
    let task!: Promise<void>;
    act(() => { task = h.result.current.pick("av1"); });
    expect(h.result.current.pending).toBe(true);
    await act(() => h.result.current.pick("jpeg"));
    expect(rcApplySetting).toHaveBeenCalledTimes(1);
    expect(h.result.current.actualLabel).toBe("H.264");
    await act(async () => { d.resolve(accepted); await task; });
    expect(h.result.current.value).toBe("av1");
    expect(h.result.current.actualLabel).toBe("H.264");
    expect(p.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("实际接收"), "success");
  });
  it("Mac 的超限画质先经对方确认降为均衡，再请求 AV1", async () => {
    const p = setup({ quality: "uhd60" });
    vi.mocked(rcApplySetting).mockResolvedValueOnce({ status: "accepted", value: "balanced" });
    const h = renderHook(() => useRcCodecChoice(p));
    await act(() => h.result.current.pick("av1"));
    expect(rcApplySetting).toHaveBeenNthCalledWith(1, "owned-a", "quality", "balanced");
    expect(rcApplySetting).toHaveBeenNthCalledWith(2, "owned-a", "codec", "av1");
    expect(p.onQuality).toHaveBeenCalledWith("balanced");
    expect(p.onStatus).toHaveBeenCalledWith(expect.stringContaining("均衡"), "info");
  });
  it("画质未确认不继续 AV1；编码被拒绝时反馈失败，不伪装生效", async () => {
    const p = setup({ quality: "auto" });
    vi.mocked(rcApplySetting).mockResolvedValueOnce({ status: "unconfirmed", value: "balanced" });
    const h = renderHook(() => useRcCodecChoice(p));
    await act(() => h.result.current.pick("av1"));
    expect(rcApplySetting).toHaveBeenCalledTimes(1);
    expect(p.onQuality).not.toHaveBeenCalled();
    expect(p.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("未确认"), "info");
    vi.mocked(rcApplySetting).mockRejectedValueOnce(new Error("对方拒绝"));
    await act(() => h.result.current.pick("jpeg"));
    expect(h.result.current.value).toBe("h264");
    expect(p.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("对方拒绝"), "error");
  });
  it("旧会话的迟到结果不发送新请求、不修改新会话状态", async () => {
    const p = setup({ quality: "uhd" }); const d = deferred();
    vi.mocked(rcApplySetting).mockReturnValueOnce(d.promise);
    const h = renderHook(props => useRcCodecChoice(props), { initialProps: p });
    let task!: Promise<void>; act(() => { task = h.result.current.pick("av1"); });
    h.rerender({ ...p, sessionId: "owned-b" });
    await act(async () => { d.resolve({ status: "accepted", value: "balanced" }); await task; });
    expect(rcApplySetting).toHaveBeenCalledTimes(1);
    expect(h.result.current.pending).toBe(false);
    expect(p.onQuality).not.toHaveBeenCalled();
    expect(h.result.current.value).toBe("h264");
  });
  it("旧版本没有回执时说未确认；卸载后不写反馈", async () => {
    const p = setup();
    vi.mocked(rcApplySetting).mockResolvedValueOnce({ status: "unconfirmed", value: "av1" });
    const h = renderHook(() => useRcCodecChoice(p));
    await act(() => h.result.current.pick("av1"));
    expect(p.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("未确认"), "info");
    const d = deferred(); vi.mocked(rcApplySetting).mockReturnValueOnce(d.promise);
    let task!: Promise<void>; act(() => { task = h.result.current.pick("jpeg"); });
    const calls = p.onStatus.mock.calls.length; h.unmount();
    d.reject(new Error("已结束")); await task;
    expect(p.onStatus).toHaveBeenCalledTimes(calls);
  });
});
