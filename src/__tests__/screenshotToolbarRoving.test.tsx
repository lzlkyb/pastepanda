/**
 * 截图属性条的漫游焦点（WAI-ARIA toolbar 模式）。
 *
 * 盯四件光看代码很容易说“当然对”、坏了又不会报错的事：
 *
 * 1. 整条栏只有**一个** Tab 位——展开时二十多个按钮全进 Tab 序的话，
 *    要敲二十多下才能走到「完成」；
 * 2. 方向键在组内移动焦点，并把 Tab 落点一起带过去；
 * 3. 🔴 方向键必须 `stopPropagation`：ScreenshotOverlay 在 window 上同样绑了
 *    方向键（微调选区 / 挪标注），不拦就会「焦点右移」+「选区右移 1px」同时发生；
 * 4. 不属于本栏的键（字母快捷键等）**不能**被拦——那些全靠那个 window 监听器干活。
 *
 * 第 3、4 条是一对：只写第 3 条，哪天改成「所有键都 stopPropagation」也还是绿的。
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AttrBar } from "@/components/screenshot/AttrBar";

function renderBar() {
  return render(
    <AttrBar
      left={0}
      top={0}
      attach="below"
      showColor
      color="#EF4444"
      onSelectColor={() => {}}
      pickerOn={false}
      onPicker={() => {}}
      showWidth
      widthId="mid"
      onSelectWidth={() => {}}
      showArrow
      arrowStyle="single"
      onSelectArrowStyle={() => {}}
    />,
  );
}

/** 本栏里的全部按钮（DOM 顺序） */
function buttons(): HTMLButtonElement[] {
  const bar = document.querySelector(".attr-bar")!;
  return Array.from(bar.querySelectorAll("button"));
}

describe("属性条的漫游焦点", () => {
  it("整条栏只留一个 Tab 位，且落在当前选中项上", () => {
    renderBar();
    const btns = buttons();
    expect(btns.length).toBeGreaterThan(5); // 九个色点 + 吸管 + 四档粗细 + 两个箭头
    const tabbable = btns.filter((b) => b.tabIndex === 0);
    expect(tabbable.length).toBe(1);
    // 首次落点优先给当前选中项（这里是选中的那个颜色）
    expect(tabbable[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("方向键在组内移焦点，并把 Tab 落点一起带过去", () => {
    renderBar();
    const btns = buttons();
    btns[0].focus();
    // 手动把落点归位（真实场景里由 onFocus 完成，这里 fireEvent.focus 也会触发）
    fireEvent.focus(btns[0]);
    expect(btns[0].tabIndex).toBe(0);

    fireEvent.keyDown(btns[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(btns[1]);
    expect(btns[1].tabIndex).toBe(0);
    expect(btns[0].tabIndex).toBe(-1);

    // 头部向左回绕到末尾（APG 口径）
    fireEvent.keyDown(btns[1], { key: "ArrowLeft" });
    fireEvent.keyDown(btns[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(btns[btns.length - 1]);

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(btns[0]);
  });

  it("🔴 方向键不得冒泡到 window（那里绑着「微调选区 / 挪标注」）", () => {
    renderBar();
    const btns = buttons();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      btns[0].focus();
      fireEvent.keyDown(btns[0], { key: "ArrowRight", bubbles: true });
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("不属于本栏的键照样放行（字母快捷键靠 window 监听器干活）", () => {
    renderBar();
    const btns = buttons();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      btns[0].focus();
      fireEvent.keyDown(btns[0], { key: "r", bubbles: true });
      fireEvent.keyDown(btns[0], { key: "Enter", bubbles: true });
      expect(onWindowKey).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });
});
