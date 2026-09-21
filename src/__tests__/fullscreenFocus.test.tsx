/**
 * 第 3 批工作台化（专注模式 / 守护）的守卫单测。
 *
 * 防的回归：
 * - 专注模式的保存徽章钉必须渲染（规则 15：状态栏被隐藏后失败反馈不能跟着消失）；
 * - ConfirmDialog 第三条路（守护-2）：安全默认（autoFocus）落在「返回编辑」，
 *   Esc/遮罩 → onCancel，绝不默认丢稿；
 * - PreviewErrorBoundary（守护-1）：子组件抛错不能白屏，重试要真的重挂载；
 * - 类引用完整性同前两批（styles.X 指向不存在的类只有 undefined）。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { FocusChrome } from "@/components/editors/fullscreen/FocusChrome";
import { PreviewErrorBoundary } from "@/components/editors/fullscreen/PreviewErrorBoundary";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SaveBadge } from "@/components/editors/fullscreen/EditorStatusBar";

afterEach(cleanup);

// ConfirmDialog 的动效 hook 依赖 matchMedia，jsdom 没有 —— 测试环境补一个静态 stub
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const sel = (cls: string) => `[class*="${cls}"]`;
const q = (root: Element, cls: string) => root.querySelector(sel(cls));

describe("FocusChrome（P1-3 专注模式浮层）", () => {
  const base = {
    icon: "MD",
    fileName: "周报.md",
    onSave: vi.fn(),
    onExit: vi.fn(),
  };

  it("迷你工具栏（热区/文件名/退出键）+ 保存徽章钉 + toast 齐备", () => {
    const { container } = render(<FocusChrome {...base} isDirty={false} isSaving={false} autoSaveError={false} toastVisible />);

    expect(q(container, "focusTbHotzone")).toBeTruthy();
    expect(q(container, "focusTbName")!.textContent).toBe("周报.md");
    const exit = screen.getByText("退出专注");
    fireEvent.click(exit);
    expect(base.onExit).toHaveBeenCalled();

    // 保存钉：同一份 SaveBadge，失败态文案可见且可点（= 手动保存）
    const pin = q(container, "focusSavePin")!;
    expect(q(pin, "saveBadge")!.textContent).toBe("已保存");
    fireEvent.click(pin);
    expect(base.onSave).toHaveBeenCalled();

    expect(q(container, "focusToast")).toBeTruthy();
  });

  it("失败态徽章钉显示「自动保存失败 · Ctrl+S 重试」——规则 15 的专注模式落点", () => {
    const { container } = render(
      <FocusChrome {...base} isDirty isSaving={false} autoSaveError toastVisible={false} />
    );
    expect(q(container, "focusSavePin")!.textContent).toContain("自动保存失败");
    // toast 只在窗口期内出现
    expect(q(container, "focusToast")).toBeNull();
  });
});

describe("ConfirmDialog 第三条路（守护-2 关闭三选一）", () => {
  it("extra 动作渲染在 取消 与 确认 之间，默认焦点落在 cancel（返回编辑）", () => {
    const onConfirm = vi.fn();
    const onExtra = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="还有未保存的修改"
        message="如果现在关闭，这次编辑的内容将不会保留。"
        confirmText="保存并关闭"
        cancelText="返回编辑"
        extraText="不保存"
        onConfirm={onConfirm}
        onExtra={onExtra}
        onCancel={onCancel}
      />
    );

    const extra = screen.getByText("不保存");
    fireEvent.click(extra);
    expect(onExtra).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    // 安全默认：默认焦点必须落在「返回编辑」上，不能是任何会丢稿的路径。
    // React 19 的 autoFocus 是命令式 focus（不渲染 autofocus attribute），查 activeElement。
    expect(document.activeElement?.textContent).toBe("返回编辑");
    const cancel = screen.getByText("返回编辑");
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalled();
  });

  it("不传 extra 时保持两键形态（存量调用方零感知）", () => {
    render(<ConfirmDialog open title="t" message="m" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText("不保存")).toBeNull();
    expect(screen.getByText("确认")).toBeTruthy();
  });
});

describe("PreviewErrorBoundary（守护-1：预览失败不白屏）", () => {
  /** 受控炸弹：shouldThrow=true 时渲染期抛错 */
  function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
    if (shouldThrow) throw new Error("mermaid 炸了");
    return <div data-testid="ok">预览内容</div>;
  }

  /** 宿主行为模拟：重试 = key 递增强制重挂载 */
  function Host({ fail }: { fail: boolean }) {
    const [key, setKey] = useState(0);
    return (
      <PreviewErrorBoundary onRetry={() => setKey((k) => k + 1)} onShowSource={vi.fn()}>
        <Bomb key={key} shouldThrow={fail} />
      </PreviewErrorBoundary>
    );
  }

  it("子组件抛错 → 显示「预览没有生成」+ 重试/显示源码，不渲染子树", () => {
    // 吞掉 React 的 error 日志噪音
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onShowSource = vi.fn();
    const { container } = render(
      <PreviewErrorBoundary onRetry={vi.fn()} onShowSource={onShowSource}>
        <Bomb shouldThrow />
      </PreviewErrorBoundary>
    );

    expect(q(container, "previewError")).toBeTruthy();
    expect(screen.getByText("预览没有生成")).toBeTruthy();
    expect(container.textContent).toContain("你的源文和未保存修改都还在");
    expect(screen.queryByTestId("ok")).toBeNull();

    fireEvent.click(screen.getByText("显示源码"));
    expect(onShowSource).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("重试重置边界并重挂载子组件；故障消失后能恢复渲染", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rerender } = render(<Host fail />);

    expect(screen.getByText("预览没有生成")).toBeTruthy();
    // 故障还在时点重试：key 递增、炸弹重炸、边界再次兜住（不能崩出白屏）
    fireEvent.click(screen.getByText("重试预览"));
    expect(screen.getByText("预览没有生成")).toBeTruthy();
    // 故障消失后再重试 → 子组件恢复渲染
    rerender(<Host fail={false} />);
    fireEvent.click(screen.getByText("重试预览"));
    expect(screen.getByTestId("ok")).toBeTruthy();
    expect(screen.queryByText("预览没有生成")).toBeNull();
    spy.mockRestore();
  });
});

describe("SaveBadge（状态栏与专注钉共用）", () => {
  it("四态判定顺序 失败 > 保存中 > 脏 > 已保存（与状态栏同一份映射）", () => {
    const { container: c1 } = render(<SaveBadge isDirty={false} isSaving={false} autoSaveError={false} />);
    expect(c1.textContent).toBe("已保存");
    cleanup();

    const { container: c2 } = render(<SaveBadge isDirty isSaving={false} autoSaveError={false} />);
    expect(c2.textContent).toBe("未保存");
    cleanup();

    // 保存中优先于脏：写盘段用户又打了字，先报「保存中…」
    const { container: c4 } = render(<SaveBadge isDirty isSaving autoSaveError={false} />);
    expect(c4.textContent).toBe("保存中…");
    cleanup();

    const { container: c3 } = render(<SaveBadge isDirty isSaving autoSaveError />);
    expect(c3.textContent).toBe("自动保存失败 · Ctrl+S 重试");
  });
});
