/**
 * 三模式切换器（D15）的行为钉死测试。
 *
 * 钉三件事：
 * ① 三个标签是 **记录 ｜ 工具 ｜ 知识**（二字名）且**不带图标**——不是审美偏好：
 *   📋 已被「全部」页签占用、📝 已被「文本」页签与片段库占用，同屏会重。
 *   三字名（剪贴板/工具箱/知识库）则在 480px 下要 162px，下载态溢出。
 * ② 点击真的改了 store 里的 appMode；
 * ③ **切换会持久化到 localStorage**。
 *   （读取侧的脏值回退在 `appStore.readAppMode` 里，它在建 store 时跑一次，
 *   要测得进模块重置，本文件**没测**——写在这里是为了不让人以为它被覆盖了。）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ModeSwitcher } from "@/components/ModeSwitcher";
import { useAppStore } from "@/stores/appStore";

const KEY = "pastepanda_app_mode";

beforeEach(() => {
  cleanup();
  localStorage.removeItem(KEY);
  useAppStore.setState({ appMode: "record" });
});

describe("ModeSwitcher", () => {
  it("三个标签是二字名且不带图标", () => {
    const { container } = render(<ModeSwitcher />);

    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["记录", "工具", "知识"]);

    // 图标冲突回归：📋 / 📝 不得出现在切换器里，它们已被顶栏页签占用
    expect(container.textContent).not.toMatch(/[\u{1F4CB}\u{1F4DD}]/u);
  });

  it("点击切换 appMode，并持久化到 localStorage", () => {
    render(<ModeSwitcher />);
    expect(useAppStore.getState().appMode).toBe("record");

    fireEvent.click(screen.getByText("工具"));
    expect(useAppStore.getState().appMode).toBe("tools");
    expect(localStorage.getItem(KEY)).toBe("tools");

    fireEvent.click(screen.getByText("知识"));
    expect(useAppStore.getState().appMode).toBe("knowledge");
    expect(localStorage.getItem(KEY)).toBe("knowledge");
  });

  it("当前模式的标签带 aria-selected", () => {
    useAppStore.setState({ appMode: "knowledge" });
    render(<ModeSwitcher />);

    expect(screen.getByText("知识").closest("button")?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("记录").closest("button")?.getAttribute("aria-selected")).toBe("false");
  });
});
