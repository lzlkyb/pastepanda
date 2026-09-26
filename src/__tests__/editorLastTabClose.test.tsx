/**
 * 「关掉最后一个标签」的回归钉子。
 *
 * 复现的现象（2026-09-26 用户报）：点关闭 → 界面显示「加载中…」→ 窗口卡住。
 *
 * 成因是链式的两条：① 关最后一个标签时把它真的从列表移除了，宿主那一帧没有任何
 * 标签可画，于是落到「零标签」分支；② 那个分支不分青红皂白画「加载中…」——
 * 把「刚关掉、正在关窗」和「还没加载完」画成同一个东西，用户看到的就是
 * 「关掉编辑器，却在加载」。
 *
 * 修法：关最后一个标签**等于关窗**，因此不再移除它 —— 内容随窗口一起退场；
 * 另加 `booted` 区分「还在加载」与「初始化失败」，后者由宿主兜底关窗。
 *
 * ⚠️ 断言指向**用户可见的后果**（内容是否还在、窗口是否真关），不指向内部字段。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FullscreenEditor } from "@/components/editors/FullscreenEditor";

const h = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/components/Toast", async (orig) => {
  const actual = await orig<typeof import("@/components/Toast")>();
  return { ...actual, useToast: () => ({ toast: h.toast }) };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async () => () => {}),
    isFullscreen: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
    setFullscreen: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }),
}));

/**
 * 文档视图替身。
 *
 * 本钉子验的是**宿主的编排**（标签生命周期 + 关闭守卫 + 零标签分支），
 * 所以把视图换成只保留「请求关闭」出口的替身：真实宿主 + 轻量视图。
 * 反过来（轻量宿主 + 真实视图）测不到这里的东西 —— 上一轮用自制 Host 的
 * 审查正是因此漏掉了「零标签」这条分支。
 */
vi.mock("@/components/editors/EditorDocument", () => ({
  EditorDocument: (props: { onRequestClose: () => void }) => (
    <button data-testid="req-close" onClick={props.onRequestClose}>
      x
    </button>
  ),
}));

const closeCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([c]) => c === "close_editor_window").length;
const docNode = () => document.querySelector('[data-testid="req-close"]');

beforeEach(() => {
  h.toast.mockReset();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (cmd: string) => {
      if (cmd === "take_editor_init") {
        return [{ content: "a\nb", contentType: "markdown", language: null }];
      }
      if (cmd === "mark_editor_ready") return [];
      if (cmd === "get_config") return {};
      return undefined;
    });
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("no-anim");
});

describe("关掉最后一个标签 = 关窗", () => {
  it("退场期间内容仍在原地（不闪空白），退场结束才真关窗", async () => {
    // 走真退场动画路径（不挂 no-anim），才能观察「退场期间」这一帧
    document.documentElement.classList.remove("no-anim");
    render(<FullscreenEditor />);
    await waitFor(() => expect(docNode()).toBeTruthy());
    expect(document.body.textContent).not.toContain("加载中");

    await act(async () => {
      fireEvent.click(docNode()!);
    });

    // ① 退场中：还没关窗，而且**文档视图仍挂在原地**。
    //    若把「最后一个标签」真的移除，这一帧会退化成空壳 —— 内容先消失、
    //    窗口再关，中间闪一下（正是要修的观感）。
    expect(closeCalls()).toBe(0);
    expect(docNode(), "退场期间内容必须还在，不能先变空壳").toBeTruthy();
    expect(document.body.textContent).not.toContain("加载中");

    // ② 越过退场时长（190ms）→ 真关窗
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    expect(closeCalls()).toBe(1);
  }, 15000);

  it("【反向】多标签时关一个不脏的标签：只关标签，窗口必须留着", async () => {
    document.documentElement.classList.add("no-anim");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "take_editor_init") {
        return [
          { content: "a", contentType: "markdown", language: null },
          { content: "b", contentType: "markdown", language: null },
        ];
      }
      if (cmd === "mark_editor_ready") return [];
      if (cmd === "get_config") return {};
      return undefined;
    });
    render(<FullscreenEditor />);
    // 两个标签 ⇒ 视图替身被渲染两份，点第一个
    await waitFor(() => expect(document.querySelectorAll('[data-testid="req-close"]').length).toBe(2));

    await act(async () => {
      fireEvent.click(document.querySelectorAll('[data-testid="req-close"]')[0]);
    });

    expect(closeCalls(), "还有标签在，窗口不该关").toBe(0);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="req-close"]').length).toBe(1),
    );
  }, 15000);
});
