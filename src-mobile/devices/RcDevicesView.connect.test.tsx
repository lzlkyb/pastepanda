import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import type { RcSession, RcTargetDevice } from "@/lib/api/rc";
import { useRcStore } from "@/stores/rcStore";
import type { ReactNode } from "react";
import { RcDevicesView } from "./RcDevicesView";

vi.mock("../ui/MobileSheet", () => ({ MobileSheet: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
  open ? <section role="dialog" aria-label={title}>{children}</section> : null }));
const pc = { node_id: "pc", name: "工作电脑", os: "windows", presence: "live", source: "rc" } as RcTargetDevice;
function setup(overrides: Partial<UseRc> = {}, session: RcSession | null = null) {
  const rc = { targets: [pc], targetsLoaded: true, reachability: {}, busy: false,
    status: { running: true, enabled: true }, request: vi.fn().mockResolvedValue(true),
    probeTargets: vi.fn().mockResolvedValue(undefined), clearError: vi.fn(), ...overrides } as unknown as UseRc;
  const scope = vi.fn();
  const props = { rc, session, onSendFiles: vi.fn(), onErrorScopeChange: scope };
  const view = render(<RcDevicesView {...props} active />);
  return { rc, scope, props, view };
}
beforeEach(() => useRcStore.setState({ error: null }));
afterEach(() => useRcStore.setState({ error: null }));

describe("设备列表直接连接", () => {
  it("一步申请控制，详情入口独立，保留后端协商能力档", async () => {
    const { rc, scope } = setup();
    expect(screen.getByRole("button", { name: "查看 工作电脑 详情" })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" })));
    expect(rc.request).toHaveBeenCalledExactlyOnceWith("pc", "control");
    expect(scope).toHaveBeenLastCalledWith(false);
  });
  it("本机的拒绝授权不误判为对方拒绝，仍允许主动连接", async () => {
    const { rc } = setup({ targets: [{ ...pc, denied: true }] });
    expect(screen.getByText(/已禁止连接本机/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" })));
    expect(rc.request).toHaveBeenCalledWith("pc", "control");
  });
  it("仅同步关系保留详情，不能绕过远控配对", () => {
    const { rc } = setup({ targets: [{ ...pc, source: "sync" }] });
    expect(screen.queryByRole("button", { name: "连接 工作电脑" })).toBeNull();
    expect(screen.getByRole("button", { name: "查看 工作电脑 详情" })).toBeEnabled();
    expect(rc.request).not.toHaveBeenCalled();
  });
  it("请求未返回时锁住其他设备连接并显示本次目标", async () => {
    let finish!: (ok: boolean) => void;
    const request = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    setup({ request, targets: [pc, { ...pc, node_id: "other", name: "家里电脑" }] });
    fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" }));
    expect(screen.getByRole("button", { name: "正在连接 工作电脑" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "连接 家里电脑" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "连接 家里电脑" }));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });
  it("A 在途时不能转入 B 详情，先写全局错误再返回 false 仍展示 A 的回执", async () => {
    let finish!: (ok: boolean) => void;
    const request = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const { rc, props, view } = setup({ request, targets: [pc, { ...pc, node_id: "other", name: "家里电脑" }] });
    fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 家里电脑 详情" }));
    expect(screen.queryByRole("dialog", { name: "设备操作" })).toBeNull();
    // Store 的真实失败顺序：先发布全局错误，然后 request 的 Promise 返回 false。
    act(() => useRcStore.setState({ error: "工作电脑拒绝了连接" }));
    view.rerender(<RcDevicesView {...props} rc={{ ...rc, error: "工作电脑拒绝了连接" }} active />);
    expect(screen.getByRole("alert")).toHaveTextContent("未能连接 工作电脑");
    expect(screen.getByRole("alert")).toHaveTextContent("工作电脑拒绝了连接");
    expect(screen.queryByRole("heading", { name: "家里电脑" })).toBeNull();
    await act(async () => finish(false));
    expect(screen.getByRole("alert")).toHaveTextContent("未能连接 工作电脑");
    expect(screen.getByRole("button", { name: "查看 家里电脑 详情" })).toBeEnabled();
    expect(screen.queryByRole("dialog", { name: "设备操作" })).toBeNull();
  });
  it.each(["busy", "channel", "session"])("%s 阻止并发或未就绪连接", (reason) => {
    const overrides = reason === "busy" ? { busy: true } : reason === "channel" ? { status: { running: false, enabled: false } } : {};
    const { rc } = setup(overrides as Partial<UseRc>, reason === "session" ? { phase: "outbound_pending", peer: "pc" } as RcSession : null);
    expect(screen.getByRole("button", { name: "连接 工作电脑" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" }));
    expect(rc.request).not.toHaveBeenCalled();
  });
  it("失败在列表常驻且可重试，切页释放错误归属", async () => {
    useRcStore.setState({ error: "电脑没有同意连接" });
    const request = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { rc, scope, props, view } = setup({ request });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" })));
    expect(screen.getByRole("alert")).toHaveTextContent("电脑没有同意连接");
    expect(screen.getByRole("button", { name: "连接 工作电脑" })).toBeEnabled();
    expect(scope).toHaveBeenLastCalledWith(true);
    view.rerender(<RcDevicesView {...props} active={false} />);
    expect(scope).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<RcDevicesView {...props} active />);
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })));
    expect(rc.request).toHaveBeenCalledTimes(2);
  });
  it("抛出的连接错误可见，按钮恢复可操作", async () => {
    setup({ request: vi.fn().mockRejectedValue("网络连接失败") });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" })));
    expect(screen.getByRole("alert")).toHaveTextContent("网络连接失败");
    expect(screen.getByRole("button", { name: "连接 工作电脑" })).toBeEnabled();
  });
  it("转入另一台设备详情前释放本页失败，不漂移到新操作域", async () => {
    const { rc } = setup({ request: vi.fn().mockRejectedValue("工作电脑连接失败"),
      targets: [pc, { ...pc, node_id: "other", name: "家里电脑" }] });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "连接 工作电脑" })));
    expect(screen.getByRole("alert")).toHaveTextContent("未能连接 工作电脑");
    fireEvent.click(screen.getByRole("button", { name: "查看 家里电脑 详情" }));
    expect(rc.clearError).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
