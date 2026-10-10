import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { SessionConnectionNotices } from "./SessionConnectionNotices";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function notices() {
  return {
    direct: { title: "已切回直连", detail: "延时会自动回落。", dismiss: vi.fn() },
    suggestion: { title: "链路已持续顺畅", detail: "当前已锁定画质。", accept: vi.fn(), dismiss: vi.fn() },
  };
}

it("连接结果只挂在工具反馈流中，保留真实自动画质动作", () => {
  const p = notices();
  const { container } = render(<SessionConnectionNotices {...p} blocked={false} />);
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(2);
  expect(container.querySelectorAll('[class*="flowHost"]')).toHaveLength(2);
  expect(document.querySelector('[class*="toastHost"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "切回自动" }));
  expect(p.suggestion.accept).toHaveBeenCalledOnce();
});

it("面板打开期间不消耗通知阅读时间，关闭后两条结果仍可见", () => {
  vi.useFakeTimers();
  const p = notices();
  const view = render(<SessionConnectionNotices {...p} blocked={false} />);
  act(() => vi.advanceTimersByTime(1000));
  view.rerender(<SessionConnectionNotices {...p} blocked />);
  act(() => vi.advanceTimersByTime(10000));
  expect(p.direct.dismiss).not.toHaveBeenCalled();
  expect(p.suggestion.dismiss).not.toHaveBeenCalled();
  view.rerender(<SessionConnectionNotices {...p} blocked={false} />);
  expect(screen.getByText("已切回直连")).toBeInTheDocument();
  expect(screen.getByText("链路已持续顺畅")).toBeInTheDocument();
});
