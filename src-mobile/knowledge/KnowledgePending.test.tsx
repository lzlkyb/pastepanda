import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { MobileArticle } from "@/lib/api/mobileArticle";
import { KnowledgePending } from "./KnowledgePending";
vi.mock("../ui/MobileSheet", () => ({ MobileSheet: ({ open, children, actions }: { open: boolean; children: ReactNode; actions: ReactNode }) => open ? <aside role="dialog">{children}{actions}</aside> : null }));
afterEach(cleanup);
it("聚合独立任务去重分享来源，失败摘要可见，选任务先关闭面板", () => {
  const onDraft = vi.fn(), onArticle = vi.fn();
  const props = { active: true, draft: { id: "draft", title: "", busy: false, locked: false, error: "", resume: onDraft, discard: vi.fn() }, edit: { id: "edit", title: "原修改", busy: false, locked: false, error: "", resume: vi.fn(), discard: vi.fn() }, incoming: [{ id: "source" }, { id: "other" }],
    articles: [{ id: "article", source_ids: ["source"], title: "文章", error: "fetch failed" } as MobileArticle],
    onArticle, onIncoming: vi.fn() };
  render(<KnowledgePending {...props} />);
  const summary = screen.getByRole("button", { name: /待处理 · 4 项/ });
  expect(summary.textContent).toContain("需要重试");
  fireEvent.click(summary); fireEvent.click(screen.getByRole("button", { name: /继续写/ }));
  expect(onDraft).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(summary); fireEvent.click(screen.getByRole("button", { name: /^文章/ }));
  expect(onArticle).toHaveBeenCalledWith("article"); expect(screen.queryByRole("dialog")).toBeNull();
});

it("保存结果未确认时说明原因，放弃禁用，仍可继续核对", () => {
  const resume = vi.fn(), discard = vi.fn(async () => true);
  render(<KnowledgePending active draft={{ id: "draft", title: "保存待核对", busy: false, locked: true, error: "", resume, discard }} articles={[]} incoming={[]} onArticle={vi.fn()} onIncoming={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /待处理/ }));
  expect(screen.getByRole("button", { name: "放弃草稿" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("保存结果尚未确认，请先继续写核对结果。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /继续写/ }));
  expect(resume).toHaveBeenCalledOnce(); expect(discard).not.toHaveBeenCalled();
});

it("确认中的草稿被替换时，不能把旧确认用于清除新草稿", () => {
  const discard = vi.fn(async () => true);
  const props = { active: true, draft: { id: "old", title: "旧草稿", busy: false, locked: false, error: "", resume: vi.fn(), discard }, articles: [], incoming: [], onArticle: vi.fn(), onIncoming: vi.fn() };
  const h = render(<KnowledgePending {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /待处理/ }));
  fireEvent.click(screen.getByRole("button", { name: "放弃草稿" }));
  expect(screen.getByRole("button", { name: "确认放弃草稿" })).toBeTruthy();
  h.rerender(<KnowledgePending {...props} draft={{ ...props.draft, id: "new", title: "新草稿" }} />);
  expect(screen.queryByRole("button", { name: "确认放弃草稿" })).toBeNull();
  expect(screen.getByRole("button", { name: /继续写/ }).textContent).toContain("新草稿");
  expect(discard).not.toHaveBeenCalled();
});
