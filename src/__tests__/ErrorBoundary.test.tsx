import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function BrokenComponent(): React.ReactElement {
  throw new Error("Test crash");
}

describe("ErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <div>Hello World</div>
      </ErrorBoundary>
    );
    expect(screen.getByText("Hello World")).toBeDefined();
  });

  it("renders error UI when child crashes", () => {
    // Suppress console.error for expected crash
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText("界面渲染异常")).toBeDefined();
    expect(screen.getByText("Test crash")).toBeDefined();

    spy.mockRestore();
  });

  it("shows retry button on error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText("🔄 重试渲染")).toBeDefined();

    spy.mockRestore();
  });

  it("passes the real error to a function fallback", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={(err) => <div>{`兜底：${err?.message}`}</div>}>
        <BrokenComponent />
      </ErrorBoundary>
    );

    // 截图窗靠这条分支把真实错误摆给用户，并在崩溃后提供唯一的逃生出口（Esc / 关闭按钮）
    expect(screen.getByText("兜底：Test crash")).toBeDefined();
    // 走了自定义 fallback 就不应再出默认错误界面
    expect(screen.queryByText("界面渲染异常")).toBeNull();

    spy.mockRestore();
  });

  it("still accepts a plain ReactNode fallback", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // 类型放宽成 ReactNode | ((error) => ReactNode) 后，既有的 ReactNode 调用点不能受影响
    render(
      <ErrorBoundary fallback={<div>静态兜底</div>}>
        <BrokenComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText("静态兜底")).toBeDefined();

    spy.mockRestore();
  });

  it("renders nothing for an explicit null fallback", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // fallback={null} 的意图是「崩了就别渲染，只弹 toast」（13 处调用点均如此）；
    // 旧实现会掉进默认错误界面，与意图相反
    const { container } = render(
      <ErrorBoundary fallback={null}>
        <BrokenComponent />
      </ErrorBoundary>
    );

    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("界面渲染异常")).toBeNull();

    spy.mockRestore();
  });
});
