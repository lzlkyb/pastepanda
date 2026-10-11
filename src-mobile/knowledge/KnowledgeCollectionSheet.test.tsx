import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeCollectionSheet } from "./KnowledgeCollectionSheet";
import type { ComponentProps } from "react";
import { setupMotionClock } from "../ui/mobileMotionTestUtils";
vi.mock("../ui/useMobileBack", () => ({ useMobileBack: () => {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const props: ComponentProps<typeof KnowledgeCollectionSheet> = {
  item: { id: "one", title: "标题", text: "正文", images: [], status: "ready", message: "", created_at: 1 },
  active: true, busy: false, error: "", hasCapture: false, target: null,
  onClose: vi.fn(), onUse: vi.fn(), onSave: vi.fn(), onDiscard: vi.fn(), onContinue: vi.fn(),
};
it("busy close is explicitly disabled instead of an active dead button", () => {
  const clock = setupMotionClock(); clock.reduced.matches = true;
  render(<KnowledgeCollectionSheet {...props} busy />);
  const close = screen.getByRole("button", { name: /保存中.*暂不能关闭/ }) as HTMLButtonElement;
  expect(close.disabled).toBe(true);
  expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("button", { name: /拖动或点击收起/ }).getAttribute("disabled")).not.toBeNull();
});
it("discard offers safe keep first and uses danger intent", () => {
  const clock = setupMotionClock(); clock.reduced.matches = true;
  render(<KnowledgeCollectionSheet {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "放弃这次收集" }));
  const keep = screen.getByRole("button", { name: "保留内容" });
  const discard = screen.getByRole("button", { name: "确认放弃这次收集" });
  expect(keep.compareDocumentPosition(discard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(discard.className).toContain("danger");
  fireEvent.click(keep);
  expect(screen.getByRole("dialog", { name: "收集内容预览" })).toBeTruthy();
  expect(props.onDiscard).not.toHaveBeenCalled();
});
it("discard busy feedback describes processing rather than saving content", () => {
  const clock = setupMotionClock(); clock.reduced.matches = true;
  const view = render(<KnowledgeCollectionSheet {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "放弃这次收集" }));
  view.rerender(<KnowledgeCollectionSheet {...props} busy />);
  const close = screen.getByRole("button", { name: /处理中.*暂不能关闭/ }) as HTMLButtonElement;
  expect(close.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: /保存中.*暂不能关闭/ })).toBeNull();
});
