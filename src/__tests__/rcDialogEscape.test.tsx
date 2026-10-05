/**
 * rc 三个弹层的 Esc 归属守卫（2026-09-27 审计 P1-2）。
 *
 * # 缺陷
 *
 * `RcPairDialog` / `RcUnoDialog` / `RcAdhocDialog` 是**唯一**三个不接
 * `useDialogEscape` 的模态层（项目里另外 15 处都走它）。它们由 `RcPairLayer`
 * 挂载，而 `RcPairLayer` 的一个宿主就是**主窗设置页**（`RcSection.tsx:304`）。
 *
 * `App.tsx:1062` 的全局 Esc 链是一条**冒泡期**的 `window` 监听，它按名单逐个
 * 判断该关谁，名单里没有这三个弹窗 ⇒ 一路落到
 * `if (state.showSettings) return close_dialog: "settings"` ⇒
 * **整个设置页被关掉**，正在核对的 6 位 PIN、刚生成的配对码/接入码一起丢。
 * 与 `useDialogEscape` 头注释里记的 2026-09-06 事故同型。
 *
 * # 为什么分两半测
 *
 * ① **两侧对账**（`dialog-backdrop` ↔ `useDialogEscape`）：漏接一个弹层
 *    不会让任何工具变红，只能靠这条扫源码的对账拦。手法照
 *    `windowCloseCapability.test.ts`（同样的「两处字面量必须同时存在」结构）。
 * ② **行为**：真按一次 Esc，断言弹层关掉、且 App 那条链**收不到事件**。
 *    这里不 mount 整个 `App.tsx`（它要全量 store + Tauri 运行时，测不动），
 *    改成在 render 之前先挂一条**冒泡期 window 监听**——
 *    与 `App.tsx:1062` 的注册目标、阶段、先后次序完全一致，
 *    复现的是机制本身而不是替身。
 *
 * # 防假绿
 *
 * 把任意一处 `useDialogEscape(onClose);` 注释掉，本文件必须有对应用例变红。
 * 改之前先跑一遍看它红，才知道这条测试真的在测东西。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcPairDialog } from "@/components/settings/RcPairDialog";
import { RcUnoDialog } from "@/components/settings/RcUnoDialog";
import { RcAdhocDialog } from "@/components/settings/RcAdhocDialog";

/* ── 只换掉与「Esc 归属」无关的东西：动画、邻居轮询、各屏内容 ── */

vi.mock("@/lib/dialogMotion", () => ({ useDialogAnim: () => ({ backdrop: {}, panel: {} }) }));

vi.mock("@/hooks/useRcNearbyPair", () => ({
  NEARBY_IDLE_POLL_MS: 5000,
  NEARBY_POLL_MS: 2000,
  useRcNearbyPair: () => ({
    neighbors: [],
    pair: null,
    done: null,
    busy: false,
    refresh: async () => {},
    startPair: async () => {},
    confirm: async () => ({ state: "waiting" }),
    cancel: async () => {},
  }),
}));

// 各屏内容与 Esc 无关，换成空壳 —— 免得把 CodeMirror / 剪贴板 / 倒计时拖进来。
vi.mock("@/components/settings/RcShortPairPane", () => ({ RcShortPairPane: () => null }));
vi.mock("@/components/settings/RcPairModeSelect", () => ({ RcPairModeSelect: () => null }));
vi.mock("@/components/settings/RcPairCreatePane", () => ({ RcPairCreatePane: () => null }));
vi.mock("@/components/settings/RcPairPastePane", () => ({ RcPairPastePane: () => null }));
vi.mock("@/components/settings/RcPairPin", () => ({ RcPairPin: () => null }));
vi.mock("@/components/settings/RcUnoGeneratePane", () => ({ GeneratePane: () => null }));
vi.mock("@/components/settings/RcUnoJoinPane", () => ({ JoinPane: () => null }));
vi.mock("@/components/settings/RcUnoPassPane", () => ({ PassPane: () => null }));
vi.mock("@/components/settings/RcAdhocCodePane", () => ({ RcAdhocCodePane: () => null }));

const rc = {
  identity: { device_name: "本机", fingerprint: "fp-self", node_id: "node-self" },
  busy: false,
} as unknown as UseRc;
const toast = vi.fn() as unknown as ToastFn;
const onCloseSpy = vi.fn();

/** 模拟 `App.tsx:1062` 那条全局 Esc 链：冒泡期、window、比弹层注册得早。 */
const appChain = vi.fn();

function pressEscape(extra: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...extra }));
  });
}

const CASES: ReadonlyArray<[string, () => ReactElement]> = [
  ["RcPairDialog", () => <RcPairDialog rc={rc} toast={toast} onClose={onCloseSpy} />],
  ["RcUnoDialog", () => <RcUnoDialog rc={rc} toast={toast} side="generate" onClose={onCloseSpy} />],
  ["RcAdhocDialog", () => <RcAdhocDialog rc={rc} toast={toast} mode="help" onClose={onCloseSpy} />],
];

describe("rc 三个弹层：Esc 归弹层自己，不落全局链", () => {
  beforeEach(() => {
    onCloseSpy.mockClear();
    appChain.mockClear();
    window.addEventListener("keydown", appChain);
  });
  afterEach(() => {
    window.removeEventListener("keydown", appChain);
    cleanup();
  });

  for (const [name, make] of CASES) {
    it(`${name}：Esc 关掉弹层，且全局链收不到这个事件`, () => {
      render(make());
      expect(appChain).not.toHaveBeenCalled(); // 还没按，先确认计数器干净

      pressEscape();

      expect(onCloseSpy).toHaveBeenCalledTimes(1);
      // 🔴 这一条才是重点：事件必须被 stopPropagation 截断在捕获期。
      //    App 那条链若收到，主窗里就是「设置页跟着一起关」。
      expect(appChain).not.toHaveBeenCalled();
    });
  }

  it("对照组：没有弹层时，同一个 Esc 确实会走到全局链（证明上面那条不是假绿）", () => {
    pressEscape();
    expect(appChain).toHaveBeenCalledTimes(1);
  });

  it("输入法合成中的 Esc 不算关闭：不关弹层，也不截断事件", () => {
    render(CASES[0][1]());
    pressEscape({ isComposing: true });
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(appChain).toHaveBeenCalledTimes(1);
  });
});

/* ── ① 两侧对账：settings/Rc*.tsx 里凡是渲染 dialog-backdrop 的，都要接 hook ── */

describe("settings/Rc*.tsx：渲染 dialog-backdrop ⇒ 必须接 useDialogEscape", () => {
  const DIR = join(process.cwd(), "src", "components", "settings");

  /**
   * 已知的三个模态层。**新增第四个 rc 弹层时把名字加进来**——
   * 这条对账的价值就在于「忘了接」和「忘了登记」都会红，
   * 而不是等到用户按 Esc 把设置页关掉才发现（AGENTS 规则 11.1 的验收标准）。
   */
  const KNOWN_MODALS = ["RcConnectionShell.tsx"];

  function modalFiles(): string[] {
    return readdirSync(DIR)
      .filter((f) => /^Rc.*\.tsx$/.test(f) && !f.includes(".test."))
      .filter((f) => readFileSync(join(DIR, f), "utf8").includes("dialog-backdrop"))
      .sort();
  }

  it("扫到的模态层集合与登记的一致（多出来 = 有人新写了弹层）", () => {
    expect(modalFiles()).toEqual(KNOWN_MODALS);
  });

  it("每个模态层都真的调用了 useDialogEscape(onClose)（只 import / 被注释掉都不算）", () => {
    for (const f of KNOWN_MODALS) {
      const src = readFileSync(join(DIR, f), "utf8");
      // 行首锚定 + 不许有 // 前缀：`// useDialogEscape(onClose);` 这种「注释掉
      // 就等于没接」的情形也必须在扫源码这一侧被拦下。
      expect(src, `${f} 没接 useDialogEscape`).toMatch(/^[ \t]*useDialogEscape\(onClose/m);
    }
  });
});
