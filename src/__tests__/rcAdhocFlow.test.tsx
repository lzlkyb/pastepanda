/**
 * 一次性协助（方案甲）接线守卫单测 —— 2026-09-18。
 *
 * 这一批最容易出的错**不是逻辑错，而是没接上**：
 *  - 协助方粘完码点了「连接」，却走进了长期配对那条收尾（进完成屏、不遗忘）；
 *  - 被协助方出完码没武装，于是「用完即忘」永远不会发生。
 * 两种表现都是**界面完全正常**，只有过几天打开设备列表才发现多了一台
 * ——tsc 与 lint 都看不见，只能靠渲染真组件、断言回调参数。
 *
 * 还有一条刻意行为要用例钉住：设置页没有会话上下文（不传 `onStartRemote`），
 * 那时必须**退回** `rc.request(peer, "view")`。这条如果哪天被当成「漏传」补上，
 * 设置页会发起一个额度/撤销窗口都不在链路里的会话。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/components/Toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/Toast")>();
  return { ...real, useToast: () => ({ toast: h.toast }) };
});
/** 动画配置读 appStore + matchMedia，与本次断言无关，直接给空 props。 */
vi.mock("@/lib/dialogMotion", () => ({ useDialogAnim: () => ({ backdrop: {}, panel: {} }) }));

import type { ToastFn } from "@/components/Toast";
import type { UseRc } from "@/hooks/useRc";
import { RcAdhocDialog } from "@/components/settings/RcAdhocDialog";
import { RcPairPastePane } from "@/components/settings/RcPairPastePane";
import { loadAdhoc } from "@/lib/rcAdhoc";
import type { RcInvite } from "@/lib/api/rc";

const CODE = "PP1-bugQfUEVVv8tD4GYuCun9xzPwY8XotEiuNSqR8tUFxKKHwFDUej6Hd4m-FkT7";
const INVITE: RcInvite = { node_id: "peerB", name: "乙机", addrs: [], ts: 0 };

const asToast = () => h.toast as unknown as ToastFn;

/** 只造本用例用得到的字段（真 UseRc 有二十来个成员）。 */
function fakeRc(over: Record<string, unknown> = {}) {
  return {
    identity: { node_id: "me", device_name: "甲机", fingerprint: "AAAA BBBB CCCC DDDD" },
    createInvite: vi.fn().mockResolvedValue({ code: CODE, expires_at: Date.now() + 30 * 60_000 }),
    previewInvite: vi.fn().mockResolvedValue(INVITE),
    pair: vi.fn().mockResolvedValue(true),
    request: vi.fn().mockResolvedValue(true),
    forget: vi.fn().mockResolvedValue(true),
    status: { session: null },
    targets: [],
    ...over,
  } as unknown as UseRc;
}

const paste = async () => {
  const ta = screen.getByPlaceholderText("粘贴对方发来的远程邀请码");
  fireEvent.change(ta, { target: { value: CODE } });
  fireEvent.blur(ta);
  await waitFor(() => expect(screen.getByText("连接")).toBeTruthy());
};

beforeEach(() => {
  localStorage.clear();
  h.toast.mockReset();
});

describe("协助方「帮别人连一次」", () => {
  it("粘码 → 按钮是「连接」（不是「发送配对请求」）→ 收尾交给 onAdhocPaired 而不是 onPaired", async () => {
    const onAdhocPaired = vi.fn();
    const onPaired = vi.fn();
    render(
      <RcPairPastePane
        previewInvite={vi.fn().mockResolvedValue(INVITE)}
        pair={vi.fn().mockResolvedValue(true)}
        selfNodeId="me"
        toast={asToast()}
        onBack={vi.fn()}
        adhoc
        onAdhocPaired={onAdhocPaired}
        onPaired={onPaired}
      />,
    );

    await paste();
    fireEvent.click(screen.getByText("连接"));

    // 🔴 必须是 peer_id 而不是显示用的指纹：收尾要拿它去 rc_forget
    await waitFor(() => expect(onAdhocPaired).toHaveBeenCalledWith("peerB", "乙机"));
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("长期配对那条路不受影响（仍然走 onPaired、按钮仍是「发送配对请求」）", async () => {
    const onAdhocPaired = vi.fn();
    const onPaired = vi.fn();
    render(
      <RcPairPastePane
        previewInvite={vi.fn().mockResolvedValue(INVITE)}
        pair={vi.fn().mockResolvedValue(true)}
        selfNodeId="me"
        toast={asToast()}
        onBack={vi.fn()}
        onPaired={onPaired}
      />,
    );

    const ta = screen.getByPlaceholderText("粘贴对方发来的远程邀请码");
    fireEvent.change(ta, { target: { value: CODE } });
    fireEvent.blur(ta);
    await waitFor(() => expect(screen.getByText("发送配对请求")).toBeTruthy());
    fireEvent.click(screen.getByText("发送配对请求"));

    await waitFor(() => expect(onPaired).toHaveBeenCalledWith("乙机"));
    expect(onAdhocPaired).not.toHaveBeenCalled();
  });

  it("粘贴的是自己的码 → 当场拦住，「连接」保持禁用（点了也发不出去）", async () => {
    render(
      <RcPairPastePane
        previewInvite={vi.fn().mockResolvedValue({ ...INVITE, node_id: "me" })}
        pair={vi.fn()}
        selfNodeId="me"
        toast={asToast()}
        onBack={vi.fn()}
        adhoc
        onAdhocPaired={vi.fn()}
      />,
    );
    const ta = screen.getByPlaceholderText("粘贴对方发来的远程邀请码");
    fireEvent.change(ta, { target: { value: CODE } });
    fireEvent.blur(ta);
    await waitFor(() => expect(screen.getByText(/本机自己的邀请码/)).toBeTruthy());
    // 按钮在（保持布局稳定）但禁用 —— 判据是 canSubmitPair，不是有没有渲染
    expect((screen.getByText("连接") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("被协助方「让别人帮我」", () => {
  it("点开即出码，并且**落盘武装**（用完即忘的前提）", async () => {
    const rc = fakeRc();
    render(<RcAdhocDialog rc={rc} toast={asToast()} mode="helpMe" onClose={vi.fn()} />);

    await waitFor(() =>
      expect((rc as unknown as { createInvite: unknown }).createInvite).toHaveBeenCalledWith("甲机"),
    );
    // 码显示出来 + 复制按钮存在
    await waitFor(() => expect(screen.getByText("复制并发送给对方")).toBeTruthy());
    // 🔴 武装只写盘：结账在常驻窗口的 useRcAdhoc 里做，对话框马上就会被关掉
    expect(loadAdhoc().armedAt).toBeGreaterThan(0);
  });

  it("🔴 生成失败**不**武装 —— 否则几小时后随手连一次会被误判成一次性而删掉设备", async () => {
    const rc = fakeRc({ createInvite: vi.fn().mockRejectedValue("邀请门打不开") });
    render(<RcAdhocDialog rc={rc} toast={asToast()} mode="helpMe" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("邀请门打不开")).toBeTruthy());
    expect(loadAdhoc().armedAt).toBe(0);
  });
});

describe("设置页上下文（没有 onStartRemote）", () => {
  it("退回 rc.request(peer, \"view\") 直发，并同样点名遗忘", async () => {
    const rc = fakeRc();
    const onClose = vi.fn();
    render(<RcAdhocDialog rc={rc} toast={asToast()} mode="helpOther" onClose={onClose} />);

    await paste();
    fireEvent.click(screen.getByText("连接"));

    await waitFor(() =>
      expect((rc as unknown as { request: unknown }).request).toHaveBeenCalledWith("peerB", "view"),
    );
    // 点名也要落盘，否则这条路上「用完即忘」永远不会发生
    expect(loadAdhoc().peers).toEqual(["peerB"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("工作台上下文（有 onStartRemote）→ 走链路发起，不再自己调 request", async () => {
    const rc = fakeRc();
    const onStartRemote = vi.fn();
    render(
      <RcAdhocDialog
        rc={rc}
        toast={asToast()}
        mode="helpOther"
        onClose={vi.fn()}
        onStartRemote={onStartRemote}
      />,
    );

    await paste();
    fireEvent.click(screen.getByText("连接"));

    await waitFor(() => expect(onStartRemote).toHaveBeenCalledWith("peerB"));
    expect((rc as unknown as { request: unknown }).request).not.toHaveBeenCalled();
  });
});
