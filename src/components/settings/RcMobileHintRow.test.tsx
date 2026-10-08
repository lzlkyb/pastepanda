/**
 * RcMobileHintRow 守卫：钉「一次性打扰」这条不变量——默认出现、点 × 后写 localStorage 且本次消失、
 * 已 dismiss 时整体不渲染。触发口径是纯判断（isMobileHintDismissed），单独测；行行为测一遍。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { OPEN_SETTINGS_EVENT } from "@/lib/openSettings";
import { MOBILE_HINT_DISMISS_KEY, RcMobileHintRow, isMobileHintDismissed } from "./RcMobileHintRow";

describe("RcMobileHintRow", () => {
  beforeEach(() => localStorage.clear());

  it("dismiss 判据：默认未关，写了标记即已关", () => {
    expect(isMobileHintDismissed()).toBe(false);
    localStorage.setItem(MOBILE_HINT_DISMISS_KEY, "1");
    expect(isMobileHintDismissed()).toBe(true);
  });

  it("未关时渲染，点 × 后写 localStorage 且本行消失", () => {
    const { container } = render(<RcMobileHintRow />);
    screen.getByText("想在手机上连这台电脑？");
    const close = container.querySelector('[aria-label="不再提示"]') as HTMLElement;
    fireEvent.click(close);
    expect(localStorage.getItem(MOBILE_HINT_DISMISS_KEY)).toBe("1");
    expect(screen.queryByText("想在手机上连这台电脑？")).toBeNull();
  });

  it("已关时整体不渲染", () => {
    localStorage.setItem(MOBILE_HINT_DISMISS_KEY, "1");
    render(<RcMobileHintRow />);
    expect(screen.queryByText("想在手机上连这台电脑？")).toBeNull();
  });

  // 🔴 键盘契约守卫（对应本轮审查发现的缺陷）：整行 onKeyDown 不得吃掉内层 × 按钮的按键。
  // 判据用真事件流——focus 到 × 上按 Enter ⇒ 不跳关于页；focus 到整行本身按 Enter ⇒ 才跳。
  it("× 上的 Enter 被放行（不误跳关于页），整行的 Enter 才跳转", () => {
    let opens = 0;
    const onOpen = () => opens++;
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    try {
      const { container } = render(<RcMobileHintRow />);
      const row = container.querySelector('[role="button"]') as HTMLElement;
      const close = container.querySelector('[aria-label="不再提示"]') as HTMLElement;
      // 按键源自 ×（e.target≠整行）：整行必须放行，交回按钮自己的键盘语义
      fireEvent.keyDown(close, { key: "Enter" });
      expect(opens).toBe(0);
      // 按键源自整行本身：正常跳关于页
      fireEvent.keyDown(row, { key: "Enter" });
      expect(opens).toBe(1);
    } finally {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
    }
  });
});
