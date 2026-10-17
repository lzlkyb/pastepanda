import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { PromptDialog } from "./PromptDialog";

afterEach(cleanup);
it("confirm dialog leaves IME Escape to the candidate window", () => {
  const cancel = vi.fn();
  render(<ConfirmDialog open title="确认删除" message="确认？" onCancel={cancel} onConfirm={vi.fn()} />);
  fireEvent.keyDown(window, { key: "Escape", isComposing: true });
  expect(cancel).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "确认删除" })).toBeTruthy();
});
it("prompt leaves IME Enter to text composition", () => {
  const confirm = vi.fn();
  render(<PromptDialog open title="文件夹名称" onCancel={vi.fn()} onConfirm={confirm} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true, keyCode: 229 });
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "文件夹名称" })).toBeTruthy();
});
it("prompt Escape closes the input dialog", () => {
  const cancel = vi.fn();
  render(<PromptDialog open title="重命名" onCancel={cancel} onConfirm={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(cancel).toHaveBeenCalledOnce();
});
it("a confirmation above the input dialog consumes Escape alone", () => {
  const cancelPrompt = vi.fn(), cancelConfirm = vi.fn();
  render(<><PromptDialog open title="重命名" onCancel={cancelPrompt} onConfirm={vi.fn()} />
    <ConfirmDialog open title="放弃" message="是否放弃" onCancel={cancelConfirm} onConfirm={vi.fn()} /></>);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(cancelConfirm).toHaveBeenCalledOnce();
  expect(cancelPrompt).not.toHaveBeenCalled();
});
