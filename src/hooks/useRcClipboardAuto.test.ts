/**
 * 剪贴板自动同步守卫单测（2026-09-23 审计，useRcClipboardAuto）。
 *
 * 钉两条真开过的毛病：
 * ① 窗口 visible 但**失焦**时系统拒读剪贴板（NotAllowedError），以前照样
 *    计失败 → 3 轮后误报「检查剪贴板权限」。现在未聚焦的拒读必须静默跳过。
 * ② 剪贴板被清空（空串）时以前不更新基线 → 「清空后再复制同样内容」永远
 *    不再推送。现在空串也更新基线（但空串本身不外发）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  push: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn(),
  hasFocus: true,
}));

vi.mock("@/lib/api/rc", () => ({ rcPushClipboard: h.push }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));

import { isUnfocusedClipboardDeny, useRcClipboardAuto } from "@/hooks/useRcClipboardAuto";

/** 按序喂给 navigator.clipboard.readText 的结果（读一次吃一个）。 */
function queueReads(values: (string | { err: unknown })[]) {
  for (const v of values) {
    if (typeof v === "string") h.readText.mockResolvedValueOnce(v);
    else h.readText.mockRejectedValueOnce(v.err);
  }
}

/** 推进 N 个 2 秒轮询，并把每拍的微任务排干净。 */
async function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

const deny = () => Object.assign(new Error("Clipboard read denied"), { name: "NotAllowedError" });

beforeEach(() => {
  vi.useFakeTimers();
  h.push.mockClear();
  h.readText.mockReset();
  h.hasFocus = true;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { readText: h.readText },
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => h.hasFocus);
});

describe("isUnfocusedClipboardDeny（纯判据，规则 11.1）", () => {
  it("只有「NotAllowedError 且窗口没焦点」才算未聚焦拒读", () => {
    expect(isUnfocusedClipboardDeny(deny(), false)).toBe(true);
    // 窗口有焦点还抛 NotAllowedError = 真·权限问题，必须计失败
    expect(isUnfocusedClipboardDeny(deny(), true)).toBe(false);
    // 其它错误（网络/后端）无论有没有焦点都不是「未聚焦拒读」
    expect(isUnfocusedClipboardDeny(new Error("boom"), false)).toBe(false);
    expect(isUnfocusedClipboardDeny(undefined, false)).toBe(false);
  });
});

describe("基线更新与外发", () => {
  it("🔴 清空后再次复制同样内容 → 要再推送（旧实现永远漏推这一条）", async () => {
    queueReads(["A", "A", "", "A"]); // 基线 → 没变 → 清空 → 又复制 A
    const { result } = renderHook(() =>
      useRcClipboardAuto({ enabled: true, canControl: true, sessionId: "s", onFailToast: vi.fn() }),
    );
    await tick(4);
    expect(h.push.mock.calls).toEqual([["A"]]);
    expect(result.current.autoFail).toBe(0);
  });

  it("建立基线那一拍不外发（B5 隐私红线）", async () => {
    queueReads(["密码123"]);
    renderHook(() =>
      useRcClipboardAuto({ enabled: true, canControl: true, sessionId: "s", onFailToast: vi.fn() }),
    );
    await tick(1);
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe("未聚焦拒读不计失败", () => {
  it("窗口失焦时连吃 3 拍 NotAllowedError → 不累计、不弹错", async () => {
    h.hasFocus = false;
    queueReads([
      { err: deny() },
      { err: deny() },
      { err: deny() },
    ]);
    const onFailToast = vi.fn();
    const { result } = renderHook(() =>
      useRcClipboardAuto({ enabled: true, canControl: true, sessionId: "s", onFailToast }),
    );
    await tick(3);
    expect(onFailToast).not.toHaveBeenCalled();
    expect(result.current.autoFail).toBe(0);
  });

  it("窗口有焦点还抛 NotAllowedError = 真权限失败 → 第 3 次要弹错（U3.5）", async () => {
    queueReads([
      { err: deny() },
      { err: deny() },
      { err: deny() },
    ]);
    const onFailToast = vi.fn();
    const { result } = renderHook(() =>
      useRcClipboardAuto({ enabled: true, canControl: true, sessionId: "s", onFailToast }),
    );
    await tick(3);
    expect(onFailToast).toHaveBeenCalledTimes(1);
    expect(result.current.autoFail).toBe(3);
  });
});
