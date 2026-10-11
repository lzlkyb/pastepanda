import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { KnowledgeArticleReadingNotice } from "./KnowledgeArticleReadingNotice";
import type { useKnowledgeArticleReading } from "./useKnowledgeArticleReading";
afterEach(cleanup);
const article = () => ({ noteId: "note-a", task: { id: "article-a", url: "https://example.com", saved_link_only: false }, missing: 2, busy: false, error: "图片下载失败", recoverAll: vi.fn(), retry: vi.fn() }) as unknown as ReturnType<typeof useKnowledgeArticleReading>;
it("缺图与错误合并为一行摘要，详情与恢复按需展开，稍后仍可重新打开", () => {
  const state = article(); render(<KnowledgeArticleReadingNotice article={state} onOriginal={vi.fn()} />);
  expect(screen.queryByText("图片下载失败")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /查看收藏状态/ }));
  expect(screen.getByText("图片下载失败")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "补齐剩余图片" })); expect(state.recoverAll).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "重新核对收藏状态" })); expect(state.retry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  expect(screen.queryByText("图片下载失败")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /查看收藏状态/ })); expect(screen.getByText("图片下载失败")).toBeVisible();
});
it("收起偏好属于当前笔记和当前错误，新错误或换笔记重新给出摘要", () => {
  const state = article(); const view = render(<KnowledgeArticleReadingNotice article={state} onOriginal={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  expect(screen.getByRole("button", { name: /查看收藏状态/ }).textContent).toBe("收藏状态");
  view.rerender(<KnowledgeArticleReadingNotice article={{ ...state, error: "网络已断开" }} onOriginal={vi.fn()} />);
  expect(screen.getByRole("button", { name: /查看收藏状态/ }).textContent).toContain("图片待补齐");
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  view.rerender(<KnowledgeArticleReadingNotice article={{ ...state, noteId: "note-b" } as ReturnType<typeof useKnowledgeArticleReading>} onOriginal={vi.fn()} />);
  expect(screen.getByRole("button", { name: /查看收藏状态/ }).textContent).toContain("图片待补齐");
});
it("仅链接收藏仍可补正文和查看原文，无状态不占阅读空间", () => {
  const state = article(); const fill = vi.fn(), original = vi.fn();
  const view = render(<KnowledgeArticleReadingNotice article={{ ...state, task: { ...state.task!, saved_link_only: true }, missing: 0, error: "" }} onFill={fill} onOriginal={original} />);
  fireEvent.click(screen.getByRole("button", { name: /查看收藏状态/ }));
  fireEvent.click(screen.getByRole("button", { name: "读取并补充正文" })); expect(fill).toHaveBeenCalledWith("article-a");
  fireEvent.click(screen.getByRole("button", { name: "查看原文" })); expect(original).toHaveBeenCalledWith("https://example.com");
  view.rerender(<KnowledgeArticleReadingNotice article={{ ...state, missing: 0, error: "" }} onOriginal={original} />);
  expect(screen.queryByRole("button")).toBeNull();
});
it("补图重试清除旧错误时保持详情与进度可见，新的失败重新提示", () => {
  const state = article(); const view = render(<KnowledgeArticleReadingNotice article={state} onOriginal={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /查看收藏状态/ }));
  view.rerender(<KnowledgeArticleReadingNotice article={{ ...state, busy: true, error: "" }} onOriginal={vi.fn()} />);
  expect(screen.getByRole("button", { name: "正在补齐…" })).toBeDisabled();
  view.rerender(<KnowledgeArticleReadingNotice article={{ ...state, busy: false, error: "新的下载失败" }} onOriginal={vi.fn()} />);
  expect(screen.getByRole("button", { name: /查看收藏状态/ }).textContent).toContain("补齐未完成");
});
