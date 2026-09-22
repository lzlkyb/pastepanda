/**
 * RcA2TitleBar 守卫单测（批7，2026-09-22）。
 *
 * 照 A 方案稿的三格「品牌 | 状态位 | 窗口按钮」。最要紧的一条是**状态位自适应**：
 * 正常路径下通道由 boot 与「打开工作台自动启动」拉起，标题栏这一格是那两条都失败
 * 时的补救入口——压成纯只读就再也没有地方能把它开起来（「把状态的唯一出口藏起来」
 * 是本项目栽过的坑，见 TopBar 里栈模式按钮那段）。所以只读态与可点态都要钉住。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RcA2TitleBar } from "./RcA2TitleBar";

function renderBar(props: Partial<Parameters<typeof RcA2TitleBar>[0]> = {}) {
  const defaults = { channelUp: true, busy: false, sessionLabel: "", onStartChannel: vi.fn() };
  return render(<RcA2TitleBar {...defaults} {...props} />);
}

describe("RcA2TitleBar（批7 自绘标题栏）", () => {
  it("整条是 deep 拖拽区（窗口 decorations(false)，能拖的只剩它）", () => {
    const { container } = renderBar();

    expect(container.firstElementChild?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("品牌是三段：图标 + PastePanda + 远程电脑", () => {
    renderBar();

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByText("PastePanda")).toBeTruthy();
    expect(screen.getByText("远程电脑")).toBeTruthy();
  });

  it("通道已开：状态位是只读一行，不是按钮", () => {
    renderBar({ channelUp: true });

    expect(screen.getByText("远程通道已开启")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /通道未启动/ })).toBeNull();
  });

  it("🔴 通道没起来：同一格变成可点的补救入口（不能只剩一句只读状态）", () => {
    const onStartChannel = vi.fn();
    renderBar({ channelUp: false, onStartChannel });

    fireEvent.click(screen.getByRole("button", { name: /通道未启动 · 点击开启/ }));

    expect(onStartChannel).toHaveBeenCalledTimes(1);
  });

  it("启动中禁用那枚补救按钮（避免连点）", () => {
    renderBar({ channelUp: false, busy: true });

    expect(screen.getByRole("button", { name: /通道未启动/ })).toHaveProperty("disabled", true);
  });

  it("有会话态文案时它占状态位（比「通道已开启」紧急）", () => {
    renderBar({ sessionLabel: "对方正在远程本机" });

    expect(screen.getByText("对方正在远程本机")).toBeTruthy();
    expect(screen.queryByText("远程通道已开启")).toBeNull();
  });

  it("三个自绘窗口按钮都在最右格", () => {
    renderBar();

    for (const name of ["最小化", "最大化", "关闭"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });
});
