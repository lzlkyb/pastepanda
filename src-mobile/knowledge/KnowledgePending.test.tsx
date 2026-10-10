import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { MobileArticle } from "@/lib/api/mobileArticle";
import { KnowledgePending } from "./KnowledgePending";
vi.mock("../ui/MobileSheet", () => ({ MobileSheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <aside role="dialog">{children}</aside> : null }));
afterEach(cleanup);
it("聚合独立任务去重分享来源，失败摘要可见，选任务先关闭面板", () => {
  const onDraft = vi.fn(), onArticle = vi.fn();
  const props = { active: true, draftTitle: "", editTitle: "原修改", incoming: [{ id: "source" }, { id: "other" }],
    articles: [{ id: "article", source_ids: ["source"], title: "文章", error: "fetch failed" } as MobileArticle],
    onDraft, onEdit: vi.fn(), onArticle, onIncoming: vi.fn() };
  render(<KnowledgePending {...props} />);
  const summary = screen.getByRole("button", { name: /待处理 · 4 项/ });
  expect(summary.textContent).toContain("需要重试");
  fireEvent.click(summary); fireEvent.click(screen.getByRole("button", { name: /继续写/ }));
  expect(onDraft).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(summary); fireEvent.click(screen.getByRole("button", { name: /^文章/ }));
  expect(onArticle).toHaveBeenCalledWith("article"); expect(screen.queryByRole("dialog")).toBeNull();
});
