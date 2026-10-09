import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { KnowledgeList } from "./KnowledgeList";

vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: () => ({
  getTotalSize: () => 152, getVirtualItems: () => [{ index: 0, start: 0 }], measureElement: vi.fn(),
}) }));
afterEach(cleanup);
it("already loaded notes remain readable while the next page is loading", () => {
  const onOpen = vi.fn();
  render(<KnowledgeList items={[{ id: "n", title: "已下载笔记", excerpt: "已有正文", updated_at: "2026-10-09", folder_id: null, folder_name: null, tags: [], common: false, reading_position: 0, last_access_at: null }]}
    loading hasMore error="" cancelled={false} scrollElement={createRef()} view="all" query="" folder="all" tag="" selected={null}
    onQuery={vi.fn()} onView={vi.fn()} onFilter={vi.fn()} onClear={vi.fn()} onOpen={onOpen} onRetry={vi.fn()} onMore={vi.fn()} onNew={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /已下载笔记/ }));
  expect(onOpen).toHaveBeenCalledWith("n");
  expect(screen.getByRole("button", { name: "正在读取…" })).toBeDisabled();
});
