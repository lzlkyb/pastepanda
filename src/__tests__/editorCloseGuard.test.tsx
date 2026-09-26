/**
 * 全屏编辑器**关闭守卫**的回归钉子。
 *
 * 钉住的都是 2026-09-26 行为审查里**实测确认**的三个坏路径中的两个
 * （第三个是自动保存的脏标记，见 `autoSaveDirty.test.tsx`）。
 * 它们的共性是：`tsc` / `eslint` / 既有单测全绿，只有真跑一遍才现形。
 *
 *   A. 「无保存目标的文档」被当成「保存失败」⇒ 关闭按钮永久失败
 *      根因：`FullscreenShell` 在 `onSave` 未传时仍注册 save handler，
 *      而那个 handler 恒返回 false（无落盘目标，本该是「没得存」而非「存失败」）。
 *
 *   B. 退场动画期间来了新内容 ⇒ `resetClosing` 只重置了标记，没取消关窗定时器，
 *      新文档入场后窗口照样被关掉。
 *
 * ⚠️ 断言都指向**用户可见的后果**（对话框文案 / 窗口是否真的被关），
 * 不指向内部字段 —— 内部字段一致只证明实现和你想的一样，而你想的可能就是错的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FullscreenShell } from "@/components/editors/FullscreenShell";
import { CloseAllDialog } from "@/components/editors/fullscreen/CloseAllDialog";
import { useEditorTabs } from "@/components/editors/fullscreen/useEditorTabs";
import { useEditorCloseGuard } from "@/components/editors/fullscreen/useEditorCloseGuard";
import type { EditorCloseGuardApi } from "@/components/editors/fullscreen/useEditorCloseGuard";

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

interface HostProps {
  /** 视图是否提供保存能力（false = 复刻 diff：可改文本但没有落盘目标） */
  withSave?: boolean;
  saveOk?: boolean;
  dirty?: boolean;
  onApi?: (api: EditorCloseGuardApi) => void;
}

/**
 * 最小宿主：复刻 `FullscreenEditor` 的接线（tabs + guard + 对话框），
 * 文档视图用 `FullscreenShell` 本体 —— 于是 `isDirty` / `canSave`
 * 都走**真实的上报链路**（Shell effect → onMeta → updateMeta → guard），
 * 不在测试里手填 meta，否则等于把要验的接线一起 mock 掉了。
 *
 * ❗ 这里是「**真视图 + 轻量宿主**」，所以**测不到 `FullscreenEditor` 自己的分支**
 * （典型是「零标签」那条渲染分支，2026-09-26 就是这么漏掉一个真 bug 的）。
 * 那类要用「**真宿主 + 轻量视图替身**」，见 `editorLastTabClose.test.tsx`。
 * 别在两处都放替身，也别指望一边能覆盖另一边。
 */
function Host({ withSave = true, saveOk = true, dirty = true, onApi }: HostProps) {
  const { tabs, tabsRef, activeId, open, close, updateMeta } = useEditorTabs();
  const guard = useEditorCloseGuard({ tabs, tabsRef, close });
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    open({ content: "a\nb", contentType: "diff" });
  }, [open]);

  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  useEffect(() => {
    if (onApi) onApi(guard);
  });

  return (
    <div>
      {tab && (
        <FullscreenShell
          icon="🔀"
          title="文本对比"
          dirty={dirty}
          onSave={withSave ? async () => saveOk : undefined}
          onClose={() => guard.requestCloseTab(tab.id)}
          onRequestClose={() => guard.requestCloseTab(tab.id)}
          onMeta={(meta) => updateMeta(tab.id, meta)}
          registerSave={(fn) => guard.registerSave(tab.id, fn)}
        >
          <div>正文</div>
        </FullscreenShell>
      )}
      <CloseAllDialog
        open={!!guard.closeIntent}
        scope={guard.closeIntent?.scope ?? "tab"}
        targets={guard.closeTargets}
        busy={guard.closeBusy}
        onSaveAll={() => void guard.saveAll()}
        onDiscard={guard.discard}
        onCancel={guard.cancelClose}
      />
    </div>
  );
}

const primaryBtn = () =>
  Array.from(document.querySelectorAll("button")).find(
    (b) =>
      b.textContent?.includes("保存并关闭") ||
      b.textContent?.includes("全部保存并关闭") ||
      b.textContent?.includes("仍然关闭"),
  ) as HTMLElement | undefined;

/** 点工具栏 ✕ → 等对话框出现 */
async function openCloseDialog() {
  const closeBtn = document.querySelector('[title="关闭 Esc"]') as HTMLElement;
  expect(closeBtn, "工具栏关闭按钮应存在").toBeTruthy();
  await act(async () => {
    fireEvent.click(closeBtn);
  });
}

const invokedCloseWindow = () =>
  vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "close_editor_window").length;

beforeEach(() => {
  h.toast.mockReset();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  if (!window.matchMedia) {
    // jsdom 不提供 matchMedia；弹框动画链上的 usePrefersReducedMotion 要用
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
  // 「窗口动画」关闭 = 跳过快照直接关窗（editor-main.tsx 会挂这个类）。
  // 需要验证退场动画本身的用例会自己把它摘掉。
  document.documentElement.classList.add("no-anim");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("no-anim");
});

describe("钉子 A：无保存目标的文档不许被当成「保存失败」", () => {
  it("脏 + 无处可存 ⇒ 按钮照实说「仍然关闭」，且真的能关掉", async () => {
    render(<Host withSave={false} />);
    await openCloseDialog();

    // ① 反馈与能力对齐：不能承诺「保存」
    expect(primaryBtn()?.textContent).toContain("仍然关闭");
    expect(document.body.textContent).toContain("无保存目标");

    // ② 点下去必须真的关掉（回归点：改前这里恒失败、窗口关不掉）
    await act(async () => {
      fireEvent.click(primaryBtn()!);
    });
    expect(invokedCloseWindow()).toBe(1);
  }, 10000);

  it("【反向】有保存能力但写盘失败 ⇒ 必须不关（守卫的本职不能被顺手改掉）", async () => {
    render(<Host withSave saveOk={false} />);
    await openCloseDialog();

    expect(primaryBtn()?.textContent).toContain("保存并关闭");
    await act(async () => {
      fireEvent.click(primaryBtn()!);
    });
    expect(invokedCloseWindow()).toBe(0);
    // 用 mock.lastCall 而不是 calls.at(-1)：tsconfig 的 lib 不含 ES2022
    expect(h.toast.mock.lastCall?.[0]).toContain("未能保存");
  }, 10000);

  it("【正常路径】有保存能力且成功 ⇒ 照常保存并关闭", async () => {
    render(<Host withSave saveOk />);
    await openCloseDialog();
    await act(async () => {
      fireEvent.click(primaryBtn()!);
    });
    expect(invokedCloseWindow()).toBe(1);
  }, 10000);
});

describe("钉子 B：退场动画期间的新内容不该被随窗口一起关掉", () => {
  it("resetClosing 之后越过 190ms 也不能关窗", async () => {
    document.documentElement.classList.remove("no-anim"); // 走真退场动画路径
    let api: EditorCloseGuardApi | null = null;
    // dirty=false ⇒ requestCloseWindow 直接进 doCloseWindow（不弹框）
    render(<Host withSave={false} dirty={false} onApi={(a) => (api = a)} />);

    await act(async () => {
      api!.requestCloseWindow();
    });
    // 退场途中新内容抵达：真实触发点是 md-editor-load → useEditorBootstrap
    await act(async () => {
      api!.resetClosing();
    });

    await new Promise((r) => setTimeout(r, 300)); // 越过 EXIT_MS(190)
    expect(invokedCloseWindow()).toBe(0);
  }, 10000);
});
