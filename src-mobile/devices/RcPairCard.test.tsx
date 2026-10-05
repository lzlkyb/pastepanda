import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RcPairCard } from "./RcPairCard";
const rc = vi.hoisted(() => ({ begin: vi.fn(), check: vi.fn(), cancel: vi.fn(), code: vi.fn() }));
vi.mock("@/lib/api/rc", () => ({
  rcPinPairBegin: rc.begin,
  rcExchangeCheck: rc.check,
  rcShortPairCancel: rc.cancel,
  rcShortPairCode: rc.code,
}));
vi.mock("./RcShowQr", () => ({ RcShowQr: () => null }));
const peer = { node_id: "pc", name: "工作电脑", expires_at: Date.now() + 180000 };
function enter(value = "12345678") {
  fireEvent.change(screen.getByLabelText("电脑的配对码"), { target: { value } });
}
function submit() {
  fireEvent.click(screen.getByRole("button", { name: "开始配对" }));
}
beforeEach(() => {
  vi.resetAllMocks();
  rc.begin.mockResolvedValue(peer);
  rc.check.mockResolvedValue("waiting");
  rc.cancel.mockResolvedValue(undefined);
  rc.code.mockResolvedValue({ code: "41820620", expires_at: Date.now() + 180000 });
});
afterEach(() => vi.useRealTimers());

describe("B 方案配对流程", () => {
  it("默认不取本机码，码不完整不能提交，完整码也不自动连接", () => {
    render(<RcPairCard onPaired={vi.fn()} />);
    expect(rc.code).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "开始配对" })).toBeDisabled();
    enter("1234567");
    expect(screen.getByRole("button", { name: "开始配对" })).toBeDisabled();
    enter();
    expect(screen.getByRole("button", { name: "开始配对" })).toBeEnabled();
    expect(rc.begin).not.toHaveBeenCalled();
    expect(screen.queryByText("关闭配对面板")).toBeNull();
  });
  it("支持粘贴 PP 载荷，失焦分组显示，提交原始八位码", async () => {
    render(<RcPairCard onPaired={vi.fn()} />);
    enter("PP-1234-5678");
    fireEvent.blur(screen.getByLabelText("电脑的配对码"));
    expect(screen.getByLabelText("电脑的配对码")).toHaveValue("1234 5678");
    submit();
    await waitFor(() => expect(rc.begin).toHaveBeenCalledWith("12345678", false));
    expect(screen.getByText("正在完成配对")).toBeTruthy();
    expect(screen.queryByLabelText("电脑的配对码")).toBeNull();
  });
  it("连接请求未返回时也能取消，迟到的结果不恢复等待", async () => {
    let resolve!: (value: typeof peer) => void;
    rc.begin.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<RcPairCard onPaired={vi.fn()} />);
    enter();
    submit();
    fireEvent.click(screen.getByRole("button", { name: "取消配对" }));
    await waitFor(() => expect(screen.getByText("已取消配对。")).toBeTruthy());
    await act(async () => {
      resolve(peer);
    });
    expect(screen.queryByText("正在完成配对")).toBeNull();
    expect(rc.check).not.toHaveBeenCalled();
    expect(screen.getByLabelText("电脑的配对码")).toHaveValue("12345678");
  });
  it("取消结束前不能重试，关闭面板不会重复发送取消", async () => {
    rc.begin.mockImplementation(() => new Promise(() => {}));
    let done!: () => void;
    rc.cancel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    const view = render(<RcPairCard onPaired={vi.fn()} />);
    enter();
    submit();
    fireEvent.click(screen.getByRole("button", { name: "取消配对" }));
    expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled();
    expect(screen.queryByText("开始配对")).toBeNull();
    view.unmount();
    await act(async () => {
      done();
    });
    expect(rc.cancel).toHaveBeenCalledTimes(1);
  });
  it("关闭正在连接的面板取消会合，迟到结果不会调用成功回调", async () => {
    let resolve!: (value: typeof peer) => void;
    rc.begin.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const paired = vi.fn();
    const view = render(<RcPairCard onPaired={paired} />);
    enter();
    submit();
    view.unmount();
    await act(async () => {
      resolve(peer);
    });
    expect(rc.cancel).toHaveBeenCalledTimes(1);
    expect(rc.check).not.toHaveBeenCalled();
    expect(paired).not.toHaveBeenCalled();
  });
  it("取消正在等待的会合后，迟到的成功轮询不通知父级", async () => {
    let resolve!: (value: string) => void;
    rc.check.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const paired = vi.fn();
    render(<RcPairCard onPaired={paired} />);
    await act(async () => { enter(); submit(); });
    fireEvent.click(screen.getByRole("button", { name: "取消配对" }));
    await waitFor(() => expect(screen.getByText("已取消配对。")).toBeTruthy());
    await act(async () => { resolve("paired"); });
    expect(paired).not.toHaveBeenCalled();
    expect(screen.queryByText("正在完成配对")).toBeNull();
  });
  it("失败反馈与重试入口同屏，修改输入清掉旧错误", async () => {
    rc.begin.mockRejectedValue("配对码已过期");
    render(<RcPairCard onPaired={vi.fn()} />);
    enter();
    submit();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("button", { name: "开始配对" })).toBeEnabled();
    enter("87654321");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("成功只回调一次，父级更新回调不会加速轮询", async () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<RcPairCard onPaired={first} />);
    await act(async () => {
      enter();
      submit();
    });
    expect(rc.check).toHaveBeenCalledTimes(1);
    view.rerender(<RcPairCard onPaired={latest} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(rc.check).toHaveBeenCalledTimes(1);
    rc.check.mockResolvedValue("paired");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(latest).toHaveBeenCalledWith("工作电脑");
    expect(first).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(latest).toHaveBeenCalledTimes(1);
  });
  it("取本机码失败可见并能重试，隐藏再出示复用有效码", async () => {
    rc.code.mockRejectedValueOnce("网络连接失败");
    render(<RcPairCard onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "出示本机配对码" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "出示本机配对码" }));
    await waitFor(() => expect(screen.getByLabelText("我的配对码")).toHaveTextContent("4182 0620"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "隐藏配对码" }));
    fireEvent.click(screen.getByRole("button", { name: "出示本机配对码" }));
    await waitFor(() => expect(screen.getByLabelText("我的配对码")).toBeTruthy());
    expect(rc.code).toHaveBeenCalledTimes(2);
  });
});
