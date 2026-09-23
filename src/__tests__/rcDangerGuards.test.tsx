/**
 * D 组（危险操作防护）守卫单测 —— 2026-09-18。
 *
 * 这两条都是「误触成本不对称」的操作：**正确的那一次不付出任何成本，只有出错的
 * 那一次才付**。也正因如此，它们最容易被后续维护里「顺手加个确认框更安全」的
 * 直觉改坏（与 U4.1 删笔记那条是同一类教训，见 noteDeleteUndo.test.tsx）。
 *
 * D1 撤回远程申请：撤销是真的（`rc_cancel_request`），但**不能闭着眼睛撤** ——
 *   后端那条命令的实现是 `svc.end_session("用户取消申请")`，它**不看阶段**。
 *   对方若在 6 秒窗口内已经点了同意，撤一下就成了「把刚连上的会话关掉」，
 *   与「撤销申请」的心智完全不符。真机上要在 6 秒内让对端点同意，手测不可复现
 *   ⇒ 这条判据只有单测能钉住（用例 3）。
 *
 * D2 免确认放权：它是**长期放行**，两个入口（主窗横幅 / 工作台被控视图）都紧挨着
 *   「立即结束」。用例 4 钉住「确认框点了取消就不能写」——`confirmDialog` 返回的是
 *   Promise<boolean>，漏判一次就是静默放权。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  confirmDialog: vi.fn(),
}));

/**
 * 只换掉 `useToast`，其余（`UNDO_WINDOW_MS`）用真实的 —— 断言要针对
 * 「用的是撤销窗口那个常量」，写死 6000 会在真实窗口被调成 8 秒时假红。
 */
vi.mock("@/components/Toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/Toast")>();
  return { ...real, useToast: () => ({ toast: h.toast }) };
});
vi.mock("@/lib/confirm", () => ({ confirmDialog: h.confirmDialog }));

import { UNDO_WINDOW_MS } from "@/components/Toast";
import type { ToastFn } from "@/components/Toast";
import { useRcLaunch } from "@/hooks/useRcLaunch";
import { useRcTrustEnable } from "@/hooks/useRcTrustEnable";
import { useRcDeviceActions } from "@/hooks/useRcDeviceActions";
import { trustEnableConfirm } from "@/lib/rcTrust";
import type { UseRc } from "@/hooks/useRc";

/** 只造本用例用得到的字段（真 UseRc 有二十来个成员，逐字段填只会淹掉重点）。 */
function fakeRc(over: Record<string, unknown> = {}) {
  return {
    status: { running: true, session: { phase: "outbound_pending" } },
    targets: [{ node_id: "peerA", name: "甲机", note: "客厅机" }],
    request: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(true),
    setDeviceTrust: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as UseRc;
}

const asToast = () => h.toast as unknown as ToastFn;

/** 把微任务队列排干净。撤回回调是 `() => void undoRequest(...)`，拿不到它的 promise。 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function launch(rc: UseRc) {
  return renderHook(({ r }: { r: UseRc }) => useRcLaunch(r, asToast()), {
    initialProps: { r: rc },
  });
}

beforeEach(() => {
  h.toast.mockReset();
  h.confirmDialog.mockReset().mockResolvedValue(true);
});

describe("D1 撤回远程申请", () => {
  it("发起成功后给「撤销」，窗口是 U4.2 那个常量", async () => {
    const rc = fakeRc();
    const { result } = launch(rc);
    await act(async () => {
      await result.current.doRequest("peerA", "control");
    });

    const call = h.toast.mock.calls[0] as unknown[];
    // 备注优先于对端自报名 —— 与设备行 displayName 同一口径
    expect(call[0]).toContain("客厅机");
    expect(call[0]).toContain("可控"); // 以哪一档发起必须写明
    expect(call[1]).toBe("info");
    expect(call[2]).toBe(UNDO_WINDOW_MS);
    expect(typeof call[7]).toBe("function"); // 第 8 参：onAction
  });

  it("还在等对方点头时，撤销真的撤回", async () => {
    const rc = fakeRc();
    const { result } = launch(rc);
    await act(async () => {
      await result.current.doRequest("peerA", "view");
    });

    const onUndo = (h.toast.mock.calls[0] as unknown[])[7] as () => void;
    onUndo();
    await flush();

    expect((rc as unknown as { cancel: () => void }).cancel).toHaveBeenCalledTimes(1);
  });

  it("🔴 对方已同意时不撤回 —— 那条命令会 end_session 把会话关掉", async () => {
    const pending = fakeRc();
    const { result, rerender } = launch(pending);
    await act(async () => {
      await result.current.doRequest("peerA", "control");
    });
    const onUndo = (h.toast.mock.calls[0] as unknown[])[7] as () => void;

    // 6 秒窗口内对端点同意：status 变成 outbound_active，撤销条还在屏幕上
    const accepted = fakeRc({ status: { session: { phase: "outbound_active" } } });
    rerender({ r: accepted });

    h.toast.mockClear();
    onUndo();
    await flush();

    expect((pending as unknown as { cancel: () => void }).cancel).not.toHaveBeenCalled();
    // 如实告知，而不是静默什么都不做（静默会被当成「按钮坏了」）
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("已同意"), "info");
  });

  it("发起失败不给撤销条（没有真的发出东西可撤）", async () => {
    const rc = fakeRc({ request: vi.fn().mockResolvedValue(false) });
    const { result } = launch(rc);
    await act(async () => {
      await result.current.doRequest("peerA", "control");
    });
    expect(h.toast).not.toHaveBeenCalled();
  });
});

describe("D2 免确认放权", () => {
  it("确认框点了取消 → 绝不写入，也不 toast", async () => {
    h.confirmDialog.mockResolvedValue(false);
    const rc = fakeRc();
    const { result } = renderHook(() => useRcTrustEnable(rc, asToast()));
    await act(async () => {
      await result.current("peerA", "客厅机");
    });

    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    expect((rc as unknown as { setDeviceTrust: () => void }).setDeviceTrust).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("确认框必须说清后果**与怎么关回**，确认后才写 trusted", async () => {
    const rc = fakeRc();
    const { result } = renderHook(() => useRcTrustEnable(rc, asToast()));
    await act(async () => {
      await result.current("peerA", "客厅机");
    });

    const opts = h.confirmDialog.mock.calls[0][0] as { message: string; variant?: string };
    expect(opts.message).toContain("直接连入"); // 后果
    expect(opts.message).toContain("恢复逐次询问"); // 关回入口
    expect(opts.variant).toBe("warning"); // 可撤回 ⇒ 不是 danger
    expect((rc as unknown as { setDeviceTrust: unknown }).setDeviceTrust).toHaveBeenCalledWith(
      "peerA",
      true,
    );
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("已开启免确认"), "success");
  });

  it("写入失败不 toast 成功（失败必须出声，但绝不许假报成功）", async () => {
    const rc = fakeRc({ setDeviceTrust: vi.fn().mockResolvedValue(false) });
    const { result } = renderHook(() => useRcTrustEnable(rc, asToast()));
    await act(async () => {
      await result.current("peerA", "客厅机");
    });
    // 🔴 B2（2026-09-23）改口径：原断言是「完全不出现 toast」，但这条 hook 同时挂在
    // **主窗横幅**上，而主窗没有错误面板（RcErrorPanel 只在工作台）——静默失败正是
    // 规则 15.3 说的「点了没反应」。现在失败必须报，只是**不许报成功**（本条原意）。
    const kinds = h.toast.mock.calls.map((call) => (call as unknown[])[1]);
    expect(kinds).not.toContain("success");
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("开启免确认失败"), "error");
  });
});

/**
 * D2b（2026-09-23 审计，规则 11.1 收口）：免确认曾被发现**双轨不一致**——
 * 会话内入口（useRcTrustEnable）有 warning 确认，设备详情「管理此设备」入口
 * （useRcDeviceActions.toggleTrust）却裸调写入。现在两处的确认参数都来自
 * `lib/rcTrust.ts` 同一份；这组守卫钉住：
 *   · 两个入口的**开启**方向都必须先过确认框；
 *   · **关闭**是收回授权、可逆，按 U4 不打断（不弹确认）。
 */
describe("D2b 免确认的两个入口都走同一份确认", () => {
  function deviceActions() {
    const onTrustToggle = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useRcDeviceActions({
        onForget: vi.fn(),
        onSetAllowed: vi.fn(),
        onTrustToggle,
        onAutoAcceptToggle: vi.fn(),
        onRename: vi.fn(),
        toast: asToast(),
      }),
    );
    return { result, onTrustToggle };
  }

  it("设备详情入口：开启免确认先弹确认，取消则绝不写入", async () => {
    const { result, onTrustToggle } = deviceActions();
    h.confirmDialog.mockResolvedValueOnce(false);
    await act(async () => {
      await result.current.toggleTrust("peerA", true, "客厅机");
    });
    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    expect(onTrustToggle).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("🔴 两个入口的确认参数一字不差（单一文案源，漂不了）", async () => {
    const rc = fakeRc();
    const { result: enable } = renderHook(() => useRcTrustEnable(rc, asToast()));
    await act(async () => {
      await enable.current("peerA", "客厅机");
    });
    const { result: actions } = renderHook(() =>
      useRcDeviceActions({
        onForget: vi.fn(),
        onSetAllowed: vi.fn(),
        onTrustToggle: vi.fn().mockResolvedValue(true),
        onAutoAcceptToggle: vi.fn(),
        onRename: vi.fn(),
        toast: asToast(),
      }),
    );
    await act(async () => {
      await actions.current.toggleTrust("peerA", true, "客厅机");
    });

    expect(h.confirmDialog).toHaveBeenCalledTimes(2);
    const calls = h.confirmDialog.mock.calls as unknown as [Record<string, unknown>][];
    expect(calls[1][0]).toEqual(calls[0][0]);
    // 且就是 lib/rcTrust 那份（warning + 说清后果与关回入口）
    expect(calls[0][0]).toEqual(trustEnableConfirm("客厅机"));
    expect(calls[0][0].variant).toBe("warning");
  });

  it("关闭免确认是收回授权：不弹确认、直接写入（U4 可撤销 > 二次确认）", async () => {
    const { result, onTrustToggle } = deviceActions();
    await act(async () => {
      await result.current.toggleTrust("peerA", false, "客厅机");
    });
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(onTrustToggle).toHaveBeenCalledWith("peerA", false);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("已恢复每次询问"), "success");
  });
});
