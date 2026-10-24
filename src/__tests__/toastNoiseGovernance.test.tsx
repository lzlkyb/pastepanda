/**
 * 🔴 批次②（通知治理 · 方案 A，2026-10-24）—— Toast 打扰度守卫。
 *
 * 改前的三个打扰源（本文件钉住它们不再回潮）：
 * 1. `error` 默认 duration=0 **常驻**：错误风暴时最多 5 条堆在右上角、逐条手关。
 * 2. 同文案无动作错误被**静默丢弃**：连着失败 5 次，用户只看到第 1 条、
 *    不知道还在持续失败（既不堆叠也不计数，信息被吞）。
 * 3. 成功提示默认 4s：复制/粘贴这类高频操作的"已复制"一屏停 4 秒，显得吵。
 *
 * 方案 A 的新口径：
 * - 无动作 error：12s 自动消失（悬停暂停照旧）；同文案 10s 内重复 → 合并计数。
 * - 带重试/撤销动作的 error：30s（动作入口不能悄悄蒸发，但也不必永驻）。
 * - success 默认 2s；info 维持 4s（被动通知需要读完）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/Toast";

// 假时钟下 framer-motion 的退场动画不会推进，exit 元素会一直挂在 DOM 里。
// 这里测的是**我们的计时/合并逻辑**，动画不在射程内——替换成直通渲染，退场即时生效。
vi.mock("framer-motion", async () => {
  const react = await import("react");
  const motion = new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        (props: Record<string, unknown>) =>
          react.createElement(tag, props, props.children as never),
    },
  );
  return {
    motion,
    AnimatePresence: (props: { children?: unknown }) =>
      react.createElement(react.Fragment, null, props.children as never),
  };
});

function Probe() {
  const { toast } = useToast();
  return (
    <>
      <button onClick={() => toast("保存失败: 磁盘满", "error")}>plain-error</button>
      <button onClick={() => toast("导出失败", "error", undefined, () => {})}>retry-error</button>
      <button onClick={() => toast("已复制", "success")}>success</button>
    </>
  );
}

function setup() {
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Toast 打扰度治理（方案 A）", () => {
  it("无动作 error 12s 自动消失（改前常驻需手关）", () => {
    setup();
    fireEvent.click(screen.getByText("plain-error"));
    expect(screen.getByRole("alert")).toBeTruthy();

    act(() => vi.advanceTimersByTime(11_000));
    expect(screen.getByRole("alert"), "12s 内还在").toBeTruthy();

    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.queryByRole("alert"), "12s 后自动消失").toBeNull();
  });

  it("同文案无动作 error 10s 内重复 → 合并一条并计数，不堆叠", () => {
    setup();
    fireEvent.click(screen.getByText("plain-error"));
    fireEvent.click(screen.getByText("plain-error"));
    fireEvent.click(screen.getByText("plain-error"));

    const alerts = screen.getAllByRole("alert");
    expect(alerts.length, "重复错误必须合并为一条").toBe(1);
    expect(alerts[0].textContent).toContain("已连续 3 次");
  });

  it("带重试按钮的 error 给 30s 长窗（12s 时仍在，30s 后消失）", () => {
    setup();
    fireEvent.click(screen.getByText("retry-error"));
    act(() => vi.advanceTimersByTime(12_000));
    expect(screen.getByRole("alert"), "动作入口 12s 时不能消失").toBeTruthy();
    act(() => vi.advanceTimersByTime(18_500));
    expect(screen.queryByRole("alert"), "30s 后收起").toBeNull();
  });

  it("success 默认 2s 消失（改前 4s）", () => {
    setup();
    fireEvent.click(screen.getByText("success"));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_900));
    expect(screen.getByRole("status"), "2s 内还在").toBeTruthy();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("status"), "2s 后消失").toBeNull();
  });
});
