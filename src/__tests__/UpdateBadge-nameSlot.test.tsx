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
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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

  // 🔴 主窗口的**手动检查入口**。之前 idle/uptodate/error 下名位是个死标签，
  // 用户只能等弹窗自己冒出来；error 时连重试都做不了。2026-09-06 修。
  it.each(["idle", "uptodate", "error"])("%s：点名字就能手动检查更新", (status) => {
    const checkForUpdate = vi.fn();
    setStatus(status, { checkForUpdate });
    renderBadge();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  // 已经在查了就不该再给一个能再触发一轮的按钮。
  it("checking：名字不可点", () => {
    setStatus("checking");
    renderBadge();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  });

  // 静态下仍然只是应用名（不吵），悬停才变成提示——那一下变化就是可供性提示，
  // 不然没人会想到名字能点。
  it("idle：悬停时名字换成「检查更新」提示", async () => {
    setStatus("idle");
    renderBadge();
    const btn = screen.getByRole("button", { name: "检查更新" });
    expect(screen.getByText(NAME)).toBeTruthy();
    fireEvent.mouseEnter(btn);
    // 版本号是异步读的，同步这一帧拿不到 → 退到文字。
    expect(screen.getByText(/检查更新/)).toBeTruthy();
    // 用 waitFor 而不是同步断言：名字↔提示现在是交叉淡入（AnimatePresence
    // mode="popLayout"），退场中的名字节点会在 DOM 里多留一小会儿。
    // 同文件「重启后回到 idle」那条已经因为同样的原因用了 findByText——
    // 钉的是「最终不显应用名」，不是「同一帧就消失」。
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull());
  });

  // 🔴 这条是「点了等于没点」的回归闸门。
  // 改之前：点名字 → status 变 checking → nameClickable 变 false → 按钮被换成裸应用名，
  // 连正在悬停的提示徽章都缩回去了，反馈是「负的」。
  it("手动点检查：名位立刻显「检查中」，不允许缩回应用名", async () => {
    setStatus("idle");
    renderBadge();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    // 不等后端：点下去那一帧就进 pending（mock 的 status 根本不会变，
    // 正好验的就是「不依赖 status 变化也有反馈」）。
    expect(await screen.findByText(/检查中/)).toBeTruthy();
    expect(screen.queryByText(NAME)).toBeNull();
  });

  // 🔴 名字按钮是被**卸载**的，而卸载不会触发 onMouseLeave——nameHover 会卡在 true，
  // 名位还回来时直接渲染成悬停徽章，而且再也不会自己恢复（要清它得先「离开」一次）。
  // 2026-09-06 用户实测到的是手动检查那条路径；这里钉接管态那条，两者同病同源。
  it("名位被顶掉再回来：不该还停在悬停徽章上（鼠标早就移开了）", async () => {
    setStatus("idle");
    const { rerender } = renderBadge();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull());

    // 名字按钮被接管态顶掉 → 卸载，onMouseLeave 永远不会触发
    setStatus("available");
    rerender(<UpdateBadge nameSlot={<span>{NAME}</span>} />);
    expect(await screen.findByText("更新 v9.9.9")).toBeTruthy();

    // 回到 idle：名位该是应用名，不是那个停在半途的悬停徽章
    setStatus("idle");
    rerender(<UpdateBadge nameSlot={<span>{NAME}</span>} />);
    expect(await screen.findByText(NAME)).toBeTruthy();
  });

  // 钉住「只有用户自己点的那一轮才占名位」这个区分没被后人改成「checking 就占」。
  // 若改成后者，应用名会因为一轮后台检查就闪一下——那比不显示更吵。
  it("后台自动 checking：名位不动，仍显应用名", () => {
    setStatus("checking");
    renderBadge();
    expect(screen.getByText(NAME)).toBeTruthy();
    expect(screen.queryByText(/检查中/)).toBeNull();
  });

  // 🔴 悬停提示必须是**徽章**，不是裸文字。
  // 同一个名位在 available / downloading / ready / checking 下出的都是
  // `.header-badge` 胶囊，只有这一个曾经是裸文字——风格不统一
  // （2026-09-06 用户反馈）。这条盯的就是别又退回去。
  it("idle：悬停提示用的是全局徽章样式", () => {
    setStatus("idle");
    renderBadge();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "检查更新" }));
    const hint = screen.getByText(/检查更新/);
    expect(hint.className).toContain("header-badge");
    // 变体用 version-badge 渐变那一套，**不能**借 `header-badge-update`：
    // 那套颜色的意思是「真有新版了」，借用就是误报。
    expect(hint.className).toContain("header-badge-check");
    expect(hint.className).not.toContain("header-badge-update");
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
