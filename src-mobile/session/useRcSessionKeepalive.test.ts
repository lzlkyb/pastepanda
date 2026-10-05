/**
 * useRcSessionKeepalive 守卫测试——钉住前台服务保活（2026-10-02）的开关纪律：
 *
 * ① 进会话恰开一次、卸载恰停一次——多开是重复通知，漏停是「会话没了
 *    通知栏还挂着远程中」的谎（规则 15：反馈与事实必须一致）；
 * ② sessionId 为空（沙盒模式）不碰命令——没有会话就不该有前台服务；
 * ③ 失败静默：保活只损失后台保险，不允许冒 unhandled rejection。
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ rcKeepaliveSet: vi.fn(async () => {}) }));
vi.mock("@/lib/api/rcCommands", () => ({ rcKeepaliveSet: api.rcKeepaliveSet }));

import { useRcSessionKeepalive } from "./useRcSessionKeepalive";

beforeEach(() => api.rcKeepaliveSet.mockClear().mockResolvedValue(undefined));
afterEach(() => vi.restoreAllMocks());

describe("useRcSessionKeepalive", () => {
  it("挂载开一次（带标题），卸载停一次", () => {
    const { unmount, rerender } = renderHook(
      ({ id, title }) => useRcSessionKeepalive(id, title),
      { initialProps: { id: "s1", title: "工作电脑" } },
    );
    expect(api.rcKeepaliveSet).toHaveBeenCalledTimes(1);
    expect(api.rcKeepaliveSet).toHaveBeenCalledWith(true, "工作电脑");
    // 标题变化（重连换设备名）→ effect 重跑：先停旧服务（旧文案）再开新，
    // 通知文案跟上现实——顺序错了通知会短暂挂着旧设备名说谎。
    rerender({ id: "s1", title: "客厅电脑" });
    expect(api.rcKeepaliveSet).toHaveBeenCalledTimes(3);
    expect(api.rcKeepaliveSet).toHaveBeenNthCalledWith(2, false, "工作电脑");
    expect(api.rcKeepaliveSet).toHaveBeenNthCalledWith(3, true, "客厅电脑");
    unmount();
    expect(api.rcKeepaliveSet).toHaveBeenLastCalledWith(false, "客厅电脑");
  });

  it("sessionId 为空（沙盒）不碰命令", () => {
    const { unmount } = renderHook(() => useRcSessionKeepalive(undefined, "x"));
    unmount();
    expect(api.rcKeepaliveSet).not.toHaveBeenCalled();
  });

  it("发送失败静默（不冒 unhandled rejection）", async () => {
    api.rcKeepaliveSet.mockRejectedValueOnce(new Error("插件未就绪"));
    const { unmount } = renderHook(() => useRcSessionKeepalive("s1", "t"));
    await Promise.resolve();
    unmount();
    await Promise.resolve();
    expect(api.rcKeepaliveSet).toHaveBeenCalledTimes(2);
  });
});
