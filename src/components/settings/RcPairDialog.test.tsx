import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcPairDialog } from "./RcPairDialog";

const api = vi.hoisted(() => ({ code: vi.fn(), begin: vi.fn(), check: vi.fn(), cancel: vi.fn(), near: vi.fn(), paste: vi.fn() }));
vi.mock("@/lib/api/rc", () => ({ rcShortPairCode: api.code, rcPinPairBegin: api.begin, rcExchangeCheck: api.check, rcShortPairCancel: api.cancel }));
vi.mock("@/lib/api/rcPair", () => ({ rcNearbyStatus: api.near, rcNearbyPair: vi.fn(), rcNearbyConfirm: vi.fn(), rcNearbyCancel: vi.fn() }));
vi.mock("@/lib/api", () => ({ readClipboardText: api.paste }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));
vi.mock("@/lib/dialogMotion", () => ({ useDialogAnim: () => ({ backdrop: {}, panel: {} }) }));
vi.mock("@/components/rc/RcShortCodeQr", () => ({ RcShortCodeQr: ({ code }: { code: string }) => <div aria-label="配对码二维码">{code}</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  api.code.mockResolvedValue({ code: "12345678", expires_at: Date.now() + 180000 });
  api.begin.mockImplementation(() => new Promise(() => {}));
  api.cancel.mockResolvedValue(undefined);
  api.near.mockResolvedValue({ neighbors: [], pair: null, done: null });
  api.check.mockResolvedValue("waiting");
});
function open(initialTab: "scan" | "code" | "nearby" = "scan") {
  const refreshTargets = vi.fn(async () => {});
  const rc = { refreshTargets } as unknown as UseRc;
  const toast = vi.fn(), onClose = vi.fn(), accepted = vi.fn();
  const view = render(<RcPairDialog rc={rc} toast={toast} initialTab={initialTab} onClose={onClose} onPairAccepted={accepted} />);
  return { ...view, refreshTargets, toast, onClose, accepted };
}
describe("统一添加设备", () => {
  it("扫码自动等待，不显示附近列表或自动读取剪贴板", async () => {
    open();
    await waitFor(() => expect(api.begin).toHaveBeenCalledWith("12345678", true));
    expect(screen.getByLabelText("配对码二维码")).toBeTruthy();
    expect(screen.queryByText("暂未发现附近设备")).toBeNull();
    expect(api.paste).not.toHaveBeenCalled();
  });
  it("切换到输入码取消旧等待；输入方使用固定角色且须显式提交", async () => {
    open();
    await waitFor(() => expect(api.begin).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "配对码" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
    const button = screen.getByRole("button", { name: "确认配对" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("对方配对码"), { target: { value: "8765 4321" } });
    expect(api.begin).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    await waitFor(() => expect(api.begin).toHaveBeenCalledWith("87654321", false));
  });
  it("粘贴失败在同一个弹窗反馈，允许继续手动输入", async () => {
    api.paste.mockRejectedValue(new Error("clipboard denied"));
    open("code");
    fireEvent.click(screen.getByRole("button", { name: "粘贴配对码" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("请手动输入"));
    expect(api.begin).not.toHaveBeenCalled();
  });
  it("完成会合不会取消成功请求，刷新并选中新设备后关闭", async () => {
    api.begin.mockResolvedValue({ node_id: "peer", name: "手机", expires_at: Date.now() + 60000 });
    api.check.mockResolvedValue("paired");
    const view = open("code");
    fireEvent.change(screen.getByLabelText("对方配对码"), { target: { value: "87654321" } });
    fireEvent.click(screen.getByRole("button", { name: "确认配对" }));
    await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1));
    expect(view.refreshTargets).toHaveBeenCalledTimes(1);
    expect(view.accepted).toHaveBeenCalledWith("peer");
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it("关闭组件取消正在等待的会合，忽略迟到的成功结果", async () => {
    let resolve!: (value: { node_id: string; name: string; expires_at: number }) => void;
    api.begin.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const view = open();
    await waitFor(() => expect(api.begin).toHaveBeenCalledTimes(1));
    view.unmount();
    resolve({ node_id: "late", name: "迟到设备", expires_at: Date.now() + 60000 });
    await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
    expect(api.check).not.toHaveBeenCalled();
    expect(view.accepted).not.toHaveBeenCalled();
  });
  it("附近发现失败显示错误，而不是伪装成没有设备", async () => {
    api.near.mockRejectedValue(new Error("network failed"));
    open("nearby");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("读取失败"));
    expect(screen.queryByText("暂未发现附近设备")).toBeNull();
    expect(api.code).not.toHaveBeenCalled();
  });
  it("离开附近页签隐藏列表，键盘可以切换页签", async () => {
    open("nearby");
    await waitFor(() => expect(screen.getByText("暂未发现附近设备")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("tab", { name: "附近设备" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "配对码" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("对方配对码")).toBeTruthy();
  });
});
