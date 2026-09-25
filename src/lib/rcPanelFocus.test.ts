/**
 * rcPanelFocus 守卫单测（Esc 两级取消，2026-09-25）。
 *
 * 计数器是 useRcInput 的 window 级 Esc 兜底与三个面板（RcDropdown / ⋯ 面板 /
 * RcHud）之间的唯一契约，两条不变量必须钉住：
 * - 成对 register/unregister 计数准确（⋯ 面板里再开下拉 = 两层，逐层归零）；
 * - 多退不成负数——退成负数会卡在「有面板」，Esc 兜底永久失效（比归零危险）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { rcPanelOpenCount, registerRcPanel, unregisterRcPanel } from "./rcPanelFocus";

describe("rcPanelFocus 面板计数器（Esc 两级取消）", () => {
  beforeEach(() => {
    // 模块级计数跨用例共享：先清干净（用 unregister 走正常路径归零）
    while (rcPanelOpenCount() > 0) unregisterRcPanel();
  });

  it("register/unregister 成对读写计数（多层面板逐层归零）", () => {
    expect(rcPanelOpenCount()).toBe(0);
    registerRcPanel(); // ⋯ 面板展开
    expect(rcPanelOpenCount()).toBe(1);
    registerRcPanel(); // 面板里再开一个下拉
    expect(rcPanelOpenCount()).toBe(2);
    unregisterRcPanel();
    unregisterRcPanel();
    expect(rcPanelOpenCount()).toBe(0);
  });

  it("多退不成负数（StrictMode/异常路径下 cleanup 配对失手也不卡死 Esc 兜底）", () => {
    expect(rcPanelOpenCount()).toBe(0);
    unregisterRcPanel();
    unregisterRcPanel();
    expect(rcPanelOpenCount()).toBe(0);
  });
});
