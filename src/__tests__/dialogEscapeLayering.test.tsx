/**
 * 快捷键的**层序**行为测试（2026-10-01 整体审计 P1 #2/#3/#12）。
 *
 * # 缺陷本体
 *
 * `window` 的捕获期监听同相位**只比注册顺序**，而「谁挂在上面」这件事源码看不出来：
 *
 * 1. 弹框自己接了 Esc，又能从内部弹统一确认框（`NoteTemplateDialogShell` 的
 *    「放弃未保存改动」）。确认框挂载比父弹框晚 ⇒ 父弹框的捕获期监听**先跑**，
 *    一 `stopPropagation()` 确认框根本收不到事件；而 `lib/confirm.ts` 遇到已有
 *    待决请求时「拒新不顶旧」，父弹框那次 `tryClose()` 又不会真关窗
 *    ⇒ **两层互相制住，按 Esc 什么都不发生**。
 * 2. 设置页的让路闸当时只认 `.dialog-backdrop`。快捷键浮层用的是
 *    `.shortcut-overlay`（`App.tsx` 的 `ShortcutPanel`），同 z=400 但 DOM 更靠后
 *    ⇒ 它盖在设置页上却不算「模态在场」，Ctrl+F 把焦点从浮层自己的搜索框抢回身后。
 * 3. `HotkeyRecorder` 录制态按 `/`：焦点被设置页抢走 → 按钮 `onBlur` → 录制静默取消。
 *
 * # 为什么这些能做成行为测试（不像搜索/导航那批只能钉源码形状）
 *
 * 层序是**事件派发顺序**问题，jsdom 完全能复现：渲染先后就是注册先后，
 * `document.dispatchEvent(new KeyboardEvent(...))` 就是那一下按键。
 * 全局链用一条**冒泡期** window 监听替身（与 `App.tsx:1067` 的目标/相位/先后完全一致）。
 *
 * # 防假绿
 *
 * 把 `useDialogEscape` 里的 `isConfirmLayerPresent()` 那行删掉 → 用例 ② 红；
 * 把 `modalLayers.ts` 选择器里的 `.shortcut-overlay` 删掉 → 用例 ④ 红；
 * 把 `HotkeyRecorder` 的 `data-hotkey-recording` 删掉 → 用例 ⑤ 红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import { blocksPageShortcuts, isConfirmLayerPresent } from "@/lib/modalLayers";
import { HotkeyRecorder } from "@/components/settings/HotkeyRecorder";

/** 父弹框替身：只做「接 Esc」这一件事，与真实弹窗在监听器上完全同构。 */
function ParentDialog({ onClose }: { onClose: () => void }) {
  useDialogEscape(onClose);
  return <div className="dialog-backdrop" data-testid="parent" />;
}

/**
 * 统一确认框替身：照 `ConfirmDialog.tsx:49-58` 的写法——
 * `.dialog-backdrop .z-confirm` 两个类 + 捕获期 + `stopPropagation()`，
 * 且**不走** `useDialogEscape`（它就是让父层让路的那个层，走 hook 会认出自己、把自已冻住）。
 */
function ConfirmLayer({ onCancel }: { onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return <div className="dialog-backdrop z-confirm" data-testid="confirm" />;
}

const appChain = vi.fn();

function pressEscape(extra: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...extra }));
  });
}

describe("Esc 层序：嵌套确认框优先于父弹框", () => {
  beforeEach(() => {
    appChain.mockClear();
    window.addEventListener("keydown", appChain); // 冒泡期，与 App 的全局链同构
  });
  afterEach(() => {
    window.removeEventListener("keydown", appChain);
    cleanup();
  });

  it("① 没有确认框时，Esc 归弹框自己，且不落到全局链", () => {
    const close = vi.fn();
    render(<ParentDialog onClose={close} />);
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);
    expect(appChain).not.toHaveBeenCalled();
  });

  it("② 确认框在场时，Esc 归确认框——父弹框让路（这就是那个「按 Esc 什么都不发生」的缺陷）", () => {
    const parentClose = vi.fn();
    const confirmCancel = vi.fn();
    // 注册顺序即挂载顺序：父弹框先挂，确认框后挂。真实场景就是这样。
    render(<ParentDialog onClose={parentClose} />);
    render(<ConfirmLayer onCancel={confirmCancel} />);

    pressEscape();

    expect(confirmCancel, "确认框必须收到这一下").toHaveBeenCalledTimes(1);
    expect(parentClose, "父弹框抢走事件就是把确认框冻住了").not.toHaveBeenCalled();
    expect(appChain).not.toHaveBeenCalled();
  });

  it("③ 输入法合成中的 Esc 谁都不关，事件原样放行", () => {
    const close = vi.fn();
    render(<ParentDialog onClose={close} />);
    pressEscape({ isComposing: true });
    expect(close).not.toHaveBeenCalled();
    expect(appChain).toHaveBeenCalledTimes(1);
  });
});

describe("blocksPageShortcuts：设置页要让路的三类浮层", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const cases: ReadonlyArray<[string, string, boolean]> = [
    ["普通弹框", '<div class="dialog-backdrop"></div>', true],
    ["嵌套确认框（它同时带 dialog-backdrop）", '<div class="dialog-backdrop z-confirm"></div>', true],
    // 🔴 这一条就是审计查出的缺口：快捷键浮层不带 .dialog-backdrop，旧的闸放行了它
    ["快捷键浮层", '<div class="shortcut-overlay"></div>', true],
    ["正在录制的快捷键控件", '<button data-hotkey-recording="true"></button>', true],
    ["什么都没挂", "<p>hi</p>", false],
  ];

  for (const [name, html, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      document.body.innerHTML = html;
      expect(blocksPageShortcuts()).toBe(expected);
    });
  }

  it("isConfirmLayerPresent 只认 .z-confirm，普通弹框不算（否则每个弹窗都会把自己冻住）", () => {
    document.body.innerHTML = '<div class="dialog-backdrop"></div>';
    expect(isConfirmLayerPresent()).toBe(false);
    document.body.innerHTML = '<div class="dialog-backdrop z-confirm"></div>';
    expect(isConfirmLayerPresent()).toBe(true);
  });
});

/**
 * 收口守卫（规则 #11.1）：**「Esc 该归谁」这条分支判断只允许有一份实现**。
 *
 * 这条缺陷的复发方式不是「有人改坏了 hook」，而是「有人新写第五份手挂捕获期 Esc 的
 * 监听」——手写副本一定会漏掉后来补进 hook 的闸（本轮就查出三份漂移的副本：
 * 缺 `isComposing`、缺「确认框在场让路」，其中一份正是设置页那两个 Kb 弹框）。
 * 所以扫全仓、按登记名单放行，第 N+1 份新写出来时这条必须变红。
 */
describe("捕获期 Esc 监听必须走 useDialogEscape，不许新写副本", () => {
  const ROOT = join(process.cwd(), "src");

  /**
   * 允许手挂的文件与**为什么**它不属于 hook 管的层：
   * - `hooks/useDialogEscape.ts` —— 判据本体。
   * - `components/ConfirmDialog.tsx` —— 它就是 hook 让路的那个 `.z-confirm` 层；
   *   走 hook 会扫到自己、把自己冻住。
   * - `components/SettingsView.tsx` / `components/ToolboxView.tsx` —— **页面级**快捷键
   *   （`/`、Ctrl+F，设置页还多一条「Esc 清搜索词」），不是「关自己」；
   *   让路判据走 `lib/modalLayers.ts`。
   * - `screenshot-main.tsx` —— 截图**独立窗口**的错误边界兜底：Esc 关的是整个窗口，
   *   且写它的前提就是「崩溃态下不能再有任何人抢走这个键」。那里没有 `.dialog-backdrop`
   *   这一层，套 hook 是把两个概念糊在一起。
   *
   * 需要让路给**非模态子面板**的（`NoteDialog` 的 CodeMirror 查找面板），传 hook 的
   * 第三参数 `yieldTo`，那是它的口子，不是手挂的理由。
   */
  const HAND_ROLLED = [
    "hooks/useDialogEscape.ts",
    "components/ConfirmDialog.tsx",
    "components/SettingsView.tsx",
    "components/ToolboxView.tsx",
    "screenshot-main.tsx",
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(p, out);
      } else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) {
        out.push(p);
      }
    }
    return out;
  }

  const handRolledFound = walk(ROOT)
    .filter((f) => /addEventListener\("keydown", onKey(?:Down)?, true\)/.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
    .sort();

  it("扫到的手挂文件集合与登记一致（多出来 = 有人新写了第五份副本）", () => {
    expect(handRolledFound).toEqual([...HAND_ROLLED].sort());
  });

  it("每一个渲染 dialog-backdrop 的弹窗都真的接了 hook", () => {
    const offenders = walk(join(ROOT, "components"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return src.includes(`className="dialog-backdrop`) && !/^[ \t]*useDialogEscape\(/m.test(src);
      })
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      // ConfirmDialog 用 `.dialog-backdrop .z-confirm`，是 hook 的例外（见上面的登记理由）
      .filter((f) => f !== "components/ConfirmDialog.tsx")
      // 主窗那批弹框（片段/提取/编码…）由 App.tsx 的**全局 Esc 分层链**代关，
      // 名单在 `keyboardActions.ts` 里逐个登记；它们不是漏接，是另一套机制。
      // 收口范围只到「设置页与它打开的弹框」，扩大时要连着改全局链，另案处理。
      .filter((f) => f.startsWith("components/settings/"));
    expect(offenders).toEqual([]);
  });
});

/**
 * 判据（消费者）与标记（生产者）必须对上：`blocksPageShortcuts` 里写了
 * `[data-hotkey-recording]`，但组件不挂这个属性的话，上一条 describe 全绿也照样是假绿。
 */
describe("HotkeyRecorder 录制态真的挂上让路标记", () => {
  afterEach(() => cleanup());

  it("点进录制态 ⇒ 带 data-hotkey-recording；退出 ⇒ 不带", () => {
    const onChange = vi.fn();
    render(<HotkeyRecorder value="ctrl+alt+v" onChange={onChange} />);
    expect(blocksPageShortcuts()).toBe(false);

    fireEvent.click(document.querySelector("button")!);
    expect(document.querySelector("[data-hotkey-recording]")).not.toBeNull();
    expect(blocksPageShortcuts(), "录制态必须让设置页的 / 与 Ctrl+F 闭嘴").toBe(true);

    fireEvent.blur(document.querySelector("button")!);
    expect(blocksPageShortcuts()).toBe(false);
  });
});
