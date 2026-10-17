import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast";

const policy = vi.hoisted(() => ({ mode: "full" }));
vi.mock("@/components/MotionPolicy", () => ({ useInterfaceMotion: () => policy.mode }));

// Exit-presence keeps a removed toast in the DOM briefly. Test its lifetime,
// not Framer's renderer clock, so expiry cannot produce a false green.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      function MotionDiv({ children, className, style, onMouseEnter, onMouseLeave, onFocusCapture, onBlurCapture, role }, ref) {
        return React.createElement("div", { ref, className, style, onMouseEnter, onMouseLeave, onFocusCapture, onBlurCapture, role }, children);
      },
    ) },
  };
});

function Actions() {
  const { toast } = useToast();
  return <>
    <button onClick={() => toast("记录已删除", "info", 6000, undefined, "撤销", undefined, undefined, () => {})}>删除</button>
    <button onClick={() => toast("保存失败，草稿已保留", "error")}>错误</button>
  </>;
}

beforeEach(() => { policy.mode = "full"; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("actionable feedback", () => {
  it("pauses native hidden windows even when document.hidden stays false", () => {
    const { rerender } = render(<ToastProvider><Actions /></ToastProvider>);
    fireEvent.click(screen.getByText("删除"));
    act(() => vi.advanceTimersByTime(2000));
    policy.mode = "hidden";
    rerender(<ToastProvider><Actions /></ToastProvider>);
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.queryByText("记录已删除")).not.toBeNull();
    policy.mode = "full";
    rerender(<ToastProvider><Actions /></ToastProvider>);
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.queryByText("记录已删除")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("记录已删除")).toBeNull();
  });

  it("keeps the undo window open while its action has keyboard focus", () => {
    render(<ToastProvider><Actions /></ToastProvider>);
    fireEvent.click(screen.getByText("删除"));
    const undo = screen.getByText("撤销");
    act(() => undo.focus());
    act(() => vi.advanceTimersByTime(6500));
    expect(screen.queryByText("记录已删除")).not.toBeNull();
  });

  it("does not silently expire an error before the user can recover", () => {
    render(<ToastProvider><Actions /></ToastProvider>);
    fireEvent.click(screen.getByText("错误"));
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText("保存失败，草稿已保留")).not.toBeNull();
  });

  it("does not stack identical repeated errors", () => {
    render(<ToastProvider><Actions /></ToastProvider>);
    fireEvent.click(screen.getByText("错误"));
    fireEvent.click(screen.getByText("错误"));
    expect(screen.queryAllByText("保存失败，草稿已保留")).toHaveLength(1);
  });
});
