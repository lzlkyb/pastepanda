import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CardCopyButton } from "./CardCopyButton";
import type { HistoryItem } from "@/stores/appStore";

const { copy, toast } = vi.hoisted(() => ({ copy: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api", () => ({ copyItemToClipboard: copy }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));
const item = { id: "a", text: "content", type: "text" } as HistoryItem;
afterEach(() => { cleanup(); copy.mockReset(); toast.mockReset(); });

it("repeating a copy cannot let the previous confirmation timer hide a pending result", async () => {
  vi.useFakeTimers();
  try {
    copy.mockResolvedValueOnce("已复制");
    render(<CardCopyButton item={item} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制" })));
    act(() => vi.advanceTimersByTime(1400));
    let resolve!: (message: string) => void;
    copy.mockReturnValue(new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: "已复制" }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("button", { name: "复制中" }).getAttribute("aria-busy")).toBe("true");
    await act(async () => resolve("已复制"));
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it("confirms copy at the button without generating another success toast", async () => {
  copy.mockResolvedValue("已复制");
  render(<CardCopyButton item={item} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制" })));
  expect(screen.queryByRole("button", { name: "已复制" })).not.toBeNull();
  expect(toast).not.toHaveBeenCalled();
});

it("a recycled row cannot display the previous record's late copy result", async () => {
  let resolve!: (value: string) => void;
  copy.mockReturnValue(new Promise(done => { resolve = done; }));
  const { rerender } = render(<CardCopyButton item={item} />);
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  rerender(<CardCopyButton item={{ ...item, id: "b" }} />);
  await act(async () => resolve("已复制"));
  expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
});

it("failure retry still gives visible feedback after the original button unmounts", async () => {
  copy.mockRejectedValueOnce(new Error("denied"));
  const { unmount } = render(<CardCopyButton item={item} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制" })));
  const retry = toast.mock.calls[0][3];
  unmount(); copy.mockResolvedValue("已复制");
  await act(async () => retry());
  expect(toast).toHaveBeenLastCalledWith("已复制", "success");
});

it("a copy failure remains visible after navigating away before completion", async () => {
  let reject!: (reason: Error) => void;
  copy.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  const { unmount } = render(<CardCopyButton item={item} />);
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  unmount();
  await act(async () => reject(new Error("clipboard busy")));
  expect(toast).toHaveBeenCalledWith("复制失败，可重试。", "error", undefined, expect.any(Function), "重试复制");
});
