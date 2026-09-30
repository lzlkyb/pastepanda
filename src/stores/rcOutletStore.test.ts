/**
 * rcOutletStore 守卫单测（甲-②，2026-09-29）。
 *
 * 这里钉的是**计时与 id 复用**两件纯函数管不了的事：
 * - `bad` 不排计时（失败常驻）；`ok` 到点自清。
 * - 同 `mergeKey` 复用旧 id ⇒ 进度刷新不重置停留时长，也不会把队列刷爆。
 * - `clear` 在换会话时被调用：上一场的失败不许飘进新画面。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRcOutlet, pushRcOutlet, useRcOutletStore } from "./rcOutletStore";

const q = () => useRcOutletStore.getState().entries;

describe("rcOutletStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRcOutlet();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("成功 2s 自清，失败常驻", () => {
    pushRcOutlet({ kind: "ok", label: "已推送" });
    pushRcOutlet({ kind: "bad", label: "重连失败" });
    expect(q()).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(q().map((e) => e.label)).toEqual(["重连失败"]);
    vi.advanceTimersByTime(60_000);
    expect(q()).toHaveLength(1);
  });

  it("信息 6s 自清（与 useOkAutoClear 同口径）", () => {
    pushRcOutlet({ kind: "info", label: "已发出请求" });
    vi.advanceTimersByTime(5_999);
    expect(q()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(q()).toHaveLength(0);
  });

  it("🔴 同 mergeKey 复用 id：进度刷新不产生新条目、也不重排", () => {
    const first = pushRcOutlet({ kind: "run", label: "传文件 1/3", mergeKey: "file" });
    const second = pushRcOutlet({ kind: "run", label: "传文件 2/3", mergeKey: "file" });
    expect(second).toBe(first);
    expect(q()).toHaveLength(1);
    expect(q()[0].label).toBe("传文件 2/3");
  });

  it("dismiss 只摘那一条，clear 一次清空（换会话）", () => {
    const a = pushRcOutlet({ kind: "bad", label: "A" });
    pushRcOutlet({ kind: "bad", label: "B" });
    useRcOutletStore.getState().dismiss(a);
    expect(q().map((e) => e.label)).toEqual(["B"]);
    clearRcOutlet();
    expect(q()).toHaveLength(0);
  });

  it("条数封顶：第 5 条把最旧的顶掉", () => {
    for (let i = 0; i < 6; i++) pushRcOutlet({ kind: "bad", label: `#${i}` });
    expect(q()).toHaveLength(4);
    expect(q()[0].label).toBe("#5");
  });

  it("ttlMs 可覆盖默认档（调用点要「多说一会儿」时不必改全局口径）", () => {
    pushRcOutlet({ kind: "ok", label: "自定义", ttlMs: 10_000 });
    vi.advanceTimersByTime(2_000);
    expect(q()).toHaveLength(1);
    vi.advanceTimersByTime(8_000);
    expect(q()).toHaveLength(0);
  });
});
