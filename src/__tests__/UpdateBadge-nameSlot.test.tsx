/**
 * 名位复用（D15）的行为钉死测试。
 *
 * 为何需要它：`UpdateBadge` 是**更新链路的唯一主动入口**，且改成名位复用后
 * 它多了一个“该不该把位置还给应用名”的判断。改错一个分支的后果不是难看，
 * 而是用户**再也收不到更新提醒**（叠上已知的 Gitee 镜像风险 = 真的发不出去）。
 *
 * 钉两件事：
 * ① 只有带可执行动作的三类状态接管名位（available / downloading / ready / installed）；
 * ② 其余四个状态一律把名位还给应用名——尤其是 **ready 之后回到 idle 时名字要立刻回来**。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { UpdateBadge } from "@/components/UpdateBadge";

const { mockUseUpdate } = vi.hoisted(() => ({ mockUseUpdate: vi.fn() }));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: mockUseUpdate,
  friendlyError: (e: unknown) => String(e),
}));

const NAME = "PastePanda";

function setStatus(status: string, overrides: Record<string, unknown> = {}) {
  mockUseUpdate.mockReturnValue({
    status,
    update: { version: "9.9.9", body: null },
    progress: 45,
    progressIndeterminate: false,
    downloadedBytes: 1048576,
    bytesPerSec: 1258291,
    error: null,
    checkForUpdate: vi.fn(),
    downloadAndInstall: vi.fn(),
    restart: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  cleanup();
  mockUseUpdate.mockReset();
});

function renderBadge() {
  return render(<UpdateBadge nameSlot={<span>{NAME}</span>} />);
}

describe("UpdateBadge 名位复用", () => {
  // 这四个状态都没有用户马上能做的事，不该抢名位。
  // uptodate / checking 曾经会在名位位置闪一个徽章，那比不显示更吵。
  it.each(["idle", "checking", "error", "uptodate"])("%s 不接管，名位显应用名", (status) => {
    setStatus(status);
    renderBadge();
    expect(screen.getByText(NAME)).toBeTruthy();
  });

  it("available：接管名位，显新版本号且可点击下载", () => {
    const downloadAndInstall = vi.fn();
    setStatus("available", { downloadAndInstall });
    renderBadge();

    expect(screen.queryByText(NAME)).toBeNull();
    // 显的是**新**版本（update.version），不是当前版本
    const btn = screen.getByText("更新 v9.9.9");
    fireEvent.click(btn);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("downloading：接管名位，显百分比与速率", () => {
    setStatus("downloading");
    renderBadge();

    expect(screen.queryByText(NAME)).toBeNull();
    expect(screen.getByText(/下载中 45%/)).toBeTruthy();
    expect(screen.getByText(/MB\/s/)).toBeTruthy();
  });

  it.each(["ready", "installed"])("%s：接管名位，点击重启", (status) => {
    const restart = vi.fn();
    setStatus(status, { restart });
    renderBadge();

    expect(screen.queryByText(NAME)).toBeNull();
    fireEvent.click(screen.getByText("重启"));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("重启后回到 idle：名字自己回来，不需任何额外动作", async () => {
    // 这条目标很具体：旧方案曾让「未读说明红点」也占名位（**得先把更新说明看完**
    // 名字才回来），已删。删它的副作用就是这条断言。
    //
    // 用 findByText 而不是 getByText：AnimatePresence 的 mode="wait" 会先等徽章淡出
    // 再挂名字节点，所以同步断言必然拿不到。那一次淡入淡出**是设计要求**
    // （不硬跳），不是 bug，因此这里钉的是「最终会回来」而不是「同一帧就回来」。
    setStatus("ready");
    const { rerender } = renderBadge();
    expect(screen.queryByText(NAME)).toBeNull();

    setStatus("idle");
    rerender(<UpdateBadge nameSlot={<span>{NAME}</span>} />);
    expect(await screen.findByText(NAME)).toBeTruthy();
  });

  it("不再渲染未读说明红点（已与设置页红点 + 自动弹窗重复，删了就不要加回来）", () => {
    setStatus("idle");
    const { container } = renderBadge();
    expect(container.querySelector(".version-badge-unseen")).toBeNull();
  });
});
