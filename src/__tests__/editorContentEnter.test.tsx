/**
 * 「内容层入场动画的触发 / 摘除 / 挂点」回归钉子。
 *
 * 复现的现象（2026-09-26 用户报）：多页签切换时闪屏，像切一次重新加载一遍。
 * 成因是 `.editorPane` / `.previewPane`（以及文档视图根的 `.overlay`）上**恒挂着**
 * CSS 入场动画，而多标签保活靠 `display: none` 切换 —— **CSS 动画在 `display`
 * 恢复时会重播**。
 *
 * 2026-09-26 用户选定 D 方案（`design/全屏编辑器-页签切换动画-设计稿.html`），
 * 语义因此**有意**改了：页签切换现在**要**播动画。但与老 bug 有三点不同 ——
 *   ① 挂点在面板内的**透明内容层**（`.editorBody` / `.previewBody`），不是
 *      不透明面板，所以不会把 `--app-bg` 透上来（老 bug 的「整片发白」）；
 *   ② 150ms / 4px（老的是 200ms / 6px，且挂在不透明面板上）；
 *   ③ 由踢号（`paneKick`）驱动且**播完就摘掉标记** —— 非活动期间标记必然为空，
 *      `display` 恢复时无动画可重播。第 ③ 条取代了旧的「干脆不触发」，
 *      是真正防 `display: none` 重播的保证（也是本文件的核心断言）。
 *
 * ⚠️ 本文件钉的是**驱动契约**（jsdom 不做 CSS 动画，重播本身测不了）；
 * 「display 往返确实会重播动画」这条 CSS 前提由真实 Chromium 验证过：
 * 恒定挂 animation 的元素在 display 往返后 `getAnimations()` 仍报出该动画名，
 * 标记类驱动且已摘除的元素报 `[]`。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useDocumentView } from "@/components/editors/fullscreen/useDocumentView";
import { FULLSCREEN_TYPES } from "@/components/editors/fullscreen/registry";

const ROOT = process.cwd();
const spec = FULLSCREEN_TYPES.markdown;

/** 标记被摘掉的时刻 = 150ms 动画 + 40ms 余量；等 260ms 稳妥 */
const SETTLE_MS = 260;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(initialActive = true) {
  const viewRef = { current: null };
  const editorRef = { current: null };
  return renderHook(
    ({ active }: { active: boolean }) =>
      useDocumentView({ spec, active, loading: false, viewRef, editorRef }),
    { initialProps: { active: initialActive } },
  );
}

beforeEach(() => {
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

describe("内容层入场动画：踢号契约", () => {
  it("首帧播一场，播完标记必被摘掉（残留 = 切回标签会重播）", async () => {
    const { result } = mount();

    // 首帧播一次，保留打开文档时的入场观感
    expect(result.current.paneKick).toBe(1);

    await act(async () => {
      await sleep(SETTLE_MS);
    });

    // ❗ 核心：必须归 0。留着标记 = 元素在 display:none 期间仍带 animation，
    //    下一次切回标签时 CSS 会重播它 —— 那正是用户报的「切个页签像重新加载」。
    expect(result.current.paneKick, "播完必须摘掉标记，否则 display 恢复时会重播").toBe(0);
  }, 15000);

  it("切页签：切走不踢号；切回踢一场（D 方案要播），播完仍归 0", async () => {
    const { result, rerender } = mount();
    await act(async () => {
      await sleep(SETTLE_MS);
    });
    expect(result.current.paneKick).toBe(0);

    // 切走：不该踢号（此刻它正要被 display:none 藏起来）
    rerender({ active: false });
    expect(result.current.paneKick, "切走不该踢号").toBe(0);

    // 切回：要踢一场 —— 这是 D 方案与旧行为（完全静默）的分界点
    rerender({ active: true });
    expect(result.current.paneKick, "切回标签要播一场内容入场（D 方案）").toBeGreaterThan(0);

    await act(async () => {
      await sleep(SETTLE_MS);
    });
    expect(result.current.paneKick, "第二场播完同样要摘干净").toBe(0);
  }, 15000);

  it("视图模式切换也必须播（原有语义不能被页签切换吞掉）", async () => {
    const { result } = mount();
    await act(async () => {
      await sleep(SETTLE_MS);
    });
    expect(result.current.paneKick).toBe(0);

    act(() => {
      result.current.setViewMode("preview");
    });
    expect(result.current.paneKick, "视图模式切换是这个动画的本来的语义").toBeGreaterThan(0);
  }, 15000);

  it("连踢两次的踢号奇偶必定交替（同名 animation 重挂类不会重播）", async () => {
    const { result } = mount();

    act(() => {
      result.current.setViewMode("preview");
    });
    const k1 = result.current.paneKick;

    // 不等 settle 就再踢一次 —— 模拟 150ms 内连点页签
    act(() => {
      result.current.setViewMode("edit");
    });
    const k2 = result.current.paneKick;

    // 自增（不是跳步，也不是固定值）
    expect(k2, "踢号必须逐次 +1").toBe(k1 + 1);
    // ❗ 奇偶不同 ⇒ 类在 contentEnterA / contentEnterB 之间交替 ⇒
    //    animation-name 变化 ⇒ 上一场没结束时重挂也会重播。
    //    若有人把踢号改成布尔或固定值，这条立刻变红。
    expect(k1 % 2, "两次连续踢号必须落在不同奇偶（A/B 交替）").not.toBe(k2 % 2);
  }, 15000);
});

describe("挂点对账：动画只能挂在透明内容层上", () => {
  const chrome = readFileSync(
    join(ROOT, "src", "components", "editors", "fullscreen", "DocumentChrome.tsx"),
    "utf8",
  );

  it("面板类名必须是裸的（不透明载体挂动画会透出 --app-bg ⇒ 整片发白）", () => {
    // 真实渲染实测：挂在面板上时 20ms 处整片发白，正是「切页签闪」的另一种形态
    expect(chrome, "editorPane 上不该挂入场动画").toMatch(/className=\{styles\.editorPane\}/);
    expect(chrome, "previewPane 上不该挂入场动画").toMatch(/className=\{styles\.previewPane\}/);
  });

  it("两个内容层（编辑 + 预览）都必须挂上入场类", () => {
    // editorBody 与 previewBody 各一处
    const hits = (chrome.match(/enterCls/g) ?? []).length;
    expect(hits, "进 editorBody / previewBody 两处都要挂，少了哪一处哪一侧就不播").toBeGreaterThanOrEqual(2);
    expect(chrome).toMatch(/styles\.editorBody\}\$\{/);
  });
});

describe("时长对账：CSS 与驱动常量的字面量必须一致", () => {
  it("CONTENT_ENTER_MS 等于 .contentEnterA 的 animation-duration", () => {
    const css = readFileSync(
      join(ROOT, "src", "components", "editors", "FullscreenEditor.module.css"),
      "utf8",
    );
    const hook = readFileSync(
      join(ROOT, "src", "components", "editors", "fullscreen", "useDocumentView.ts"),
      "utf8",
    );

    const cssMs = /\.contentEnterA\s*\{[^}]*contentInA\s+(\d+)ms/.exec(css)?.[1];
    const hookMs = /CONTENT_ENTER_MS\s*=\s*(\d+)/.exec(hook)?.[1];

    // 读不到 ⇒ 正则或锚点写坏了，不是「一致」。
    expect(cssMs, "CSS 里读不到 .contentEnterA 的时长").toBeTruthy();
    expect(hookMs, "useDocumentView 里读不到 CONTENT_ENTER_MS").toBeTruthy();
    // hook 侧比 CSS 晚摘标记（+40ms）是刻意的；但**动画时长**必须同源，
    // 否则改了一边会让动画播到一半被摘掉、或标记多留一截。
    expect(hookMs, "hook 常量与 CSS 时长必须一致").toBe(cssMs);
  });
});
