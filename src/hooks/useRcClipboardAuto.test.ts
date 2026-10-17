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

/**
 * 模块顶层（beforeEach 装假计时器之前）抓真实 setTimeout：慢取数注入把
 * readText/push 的返回值推迟一个**真实宏任务**落地——假计时器不推进它，
 * `advanceTimersByTime` + 微任务冲刷只能碰到「已调用」碰不到「已落地」。
 */
const realSetTimeout = globalThis.setTimeout;

const realTick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

/** 按序喂给 navigator.clipboard.readText 的结果（读一次吃一个）。 */
function queueReads(values: (string | { err: unknown })[]) {
  for (const v of values) {
    if (typeof v === "string") h.readText.mockResolvedValueOnce(v);
    else h.readText.mockRejectedValueOnce(v.err);
  }
}

/**
 * 推进 N 个 2 秒轮询。每拍后让出两轮**真实宏任务**：readText 结果落地一拍、
 * rcPushClipboard 结果落地一拍（注入的延迟边界数由慢取数工具口径确定，每拍链条
 * 最多两层），并把 act 的 state 冲刷掉。断言前再逐个等内容真正就位。
 */
async function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await realTick();
      await realTick();
    });
  }
}

/** 逐拍等内容判据成立（真实宏任务驱动，bounded；不成立即抛）。 */
async function untilContent(label: string, pred: () => boolean) {
  for (let tickNo = 0; ; tickNo++) {
    await act(async () => {
      await realTick();
    });
    if (pred()) return;
    if (tickNo >= 199) throw new Error(`${label}：200 拍真实宏任务内未落地`);
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
    // 等「内容」而不是等拍数：推送调用要等第 4 拍 readText 结果**落地**才会出现；
    // lastAutoAt>0 再钉住 push 链走完后半段——本用例的宏任务全部在自己体内消化，
    // 不把迟到的 "A" 漏给下一条用例（旧写法就是这样互脏）。
    await untilContent("清空后重新复制 A 触发推送", () => h.push.mock.calls.length >= 1);
    await untilContent("推送成功回执落进状态", () => result.current.lastAutoAt > 0);
    expect(h.push.mock.calls).toEqual([["A"]]);
    expect(result.current.autoFail).toBe(0);
  });

  it("建立基线那一拍不外发（B5 隐私红线）", async () => {
    queueReads(["密码123"]);
    renderHook(() =>
      useRcClipboardAuto({ enabled: true, canControl: true, sessionId: "s", onFailToast: vi.fn() }),
    );
    // tick(1) 含两轮真实宏任务：readText 结果落地（建基线）+ 若产品真外发，
    // push 调用最迟也在第一轮就绑上——断言时刻链条已不可能再产出本拍外发。
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
