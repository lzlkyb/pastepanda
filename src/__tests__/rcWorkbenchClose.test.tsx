/**
 * 工作台窗口「点 X」行为的守卫单测 —— 2026-09-18。
 *
 * 起因是一个真机 bug：**点 X 关不掉窗口**。根因是 `destroy()` 需要
 * `core:window:allow-destroy`，而 capabilities 只给了 `allow-close`；
 * 而 `@tauri-apps/api` 的 `onCloseRequested` 在**没调 preventDefault** 时
 * 收尾也走 `this.destroy()` ⇒ 有会话 / 没会话两条分支**都关不掉**，
 * 且 `void destroy()` 把拒绝吞掉，现象是「点了毫无反应」。
 * 权限那一半只能靠 `src-tauri/capabilities/rc-workbench.json`（vitest 管不到），
 * 这里钉住前端这一半。
 *
 * 另一条被这轮顺手修掉的真 bug：原实现依赖 `[hasLiveSession]` 重订阅，而
 * `unlisten` 是 `await` 之后才赋值的 ⇒ 卸载/重订阅发生在赋值之前时，
 * cleanup 里的 `unlisten?.()` 还是 undefined，**那个监听器永远摘不掉**。
 * 两个监听器同时在场时，第二个的 `confirmDialog` 会命中
 * 「已有待决请求 → 直接返回 false」，于是**绕过用户选择**立刻关窗。
 * ⇒ 用例 1 用「迟到回来的 unlisten」复现这条竞态，用例 6 钉「不再重订阅」。
 *
 * 注：本想用 `StrictMode` 双挂载直接复现，但**本仓库的 vitest 环境实测不双跑 effect**
 * （探测结果只有一次 "effect"），真按 StrictMode 写会得到一条恒真的假用例。
 * 所以改用上面那种不依赖 React 内部行为的写法。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const h = vi.hoisted(() => {
  /** 当前存活（已注册且未退订）的 close-requested 监听器 */
  const listeners: Array<(e: unknown) => unknown> = [];
  /** 受控闸门：把「unlisten 迟到」这件事做成可复现的 */
  const gates: Array<() => void> = [];
  const state = { defer: false };

  const subscribe = (handler: (e: unknown) => unknown) => {
    // 真实 API 是「先注册、再把 unlisten 交回来」——这里如实照做
    listeners.push(handler);
    const un = () => {
      const i = listeners.indexOf(handler);
      if (i >= 0) listeners.splice(i, 1);
    };
    if (state.defer) return new Promise<() => void>((res) => gates.push(() => res(un)));
    return Promise.resolve(un);
  };

  return {
    listeners,
    gates,
    state,
    onCloseRequested: vi.fn(subscribe),
    destroy: vi.fn().mockResolvedValue(undefined),
    confirmDialog: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: h.onCloseRequested, destroy: h.destroy }),
}));
vi.mock("@/lib/confirm", () => ({ confirmDialog: h.confirmDialog }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), setLevel: vi.fn() },
}));

import { useRcWorkbenchClose } from "@/hooks/useRcWorkbenchClose";

/** 排干净微任务：订阅与退订都发生在 `await` 之后。 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 模拟点系统关闭钮：拿当前唯一存活的监听器跑一遍，返回那个事件对象。 */
async function clickX() {
  const handler = h.listeners[0];
  if (!handler) throw new Error("没有存活的 close-requested 监听器");
  const ev = { preventDefault: vi.fn() };
  await act(async () => {
    await handler(ev);
  });
  return ev;
}

beforeEach(() => {
  h.listeners.length = 0;
  h.gates.length = 0;
  h.state.defer = false;
  h.onCloseRequested.mockClear();
  h.destroy.mockClear();
  h.confirmDialog.mockReset();
});

describe("useRcWorkbenchClose", () => {
  it("卸载后才回来的 unlisten 要立刻被调用（不留幽灵监听器）", async () => {
    h.state.defer = true;
    const { unmount } = renderHook(() => useRcWorkbenchClose(false, vi.fn()));
    // 订阅请求已发出并注册，但 unlisten 还没交回来
    expect(h.onCloseRequested).toHaveBeenCalledTimes(1);
    expect(h.listeners).toHaveLength(1);

    unmount();

    // 迟到的 unlisten 到达：必须当场退订，否则它会一直活着，
    // 在用户下一次点 X 时抢先用「已有待决请求 → false」把窗口关掉。
    await act(async () => {
      h.gates.forEach((g) => g());
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.listeners).toHaveLength(0);
  });

  it("没有会话：放行（不拦），交给框架自己 destroy", async () => {
    renderHook(() => useRcWorkbenchClose(false, vi.fn()));
    await flush();
    const ev = await clickX();
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("有会话：先拦下来问，确认=结束会话再关窗", async () => {
    h.confirmDialog.mockResolvedValue(true);
    const end = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRcWorkbenchClose(true, end));
    await flush();

    const ev = await clickX();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("有会话：取消=保持会话，但窗口照样关", async () => {
    h.confirmDialog.mockResolvedValue(false);
    const end = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRcWorkbenchClose(true, end));
    await flush();

    await clickX();
    expect(end).not.toHaveBeenCalled();
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("确认弹窗抛错时不僵死（按「仅关窗」继续）", async () => {
    h.confirmDialog.mockRejectedValue(new Error("宿主没挂"));
    const end = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRcWorkbenchClose(true, end));
    await flush();

    await clickX();
    expect(end).not.toHaveBeenCalled();
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("结束会话失败也要能把窗关上（用户按的是「关闭」）", async () => {
    h.confirmDialog.mockResolvedValue(true);
    const end = vi.fn().mockRejectedValue(new Error("后端不可达"));
    renderHook(() => useRcWorkbenchClose(true, end));
    await flush();

    await clickX();
    expect(end).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("会话状态变化不重订阅，但新值立刻生效（ref 读最新）", async () => {
    h.confirmDialog.mockResolvedValue(false);
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) => useRcWorkbenchClose(live, vi.fn()),
      { initialProps: { live: false } },
    );
    await flush();
    expect(h.onCloseRequested).toHaveBeenCalledTimes(1);

    // 会话开始：不重订阅（重订阅会留出「已退订、新订阅未回」的空窗）
    rerender({ live: true });
    await flush();
    expect(h.onCloseRequested).toHaveBeenCalledTimes(1);
    expect(h.listeners).toHaveLength(1);

    // 且新值确实被读到：这次要拦下来
    const ev = await clickX();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
  });
});
