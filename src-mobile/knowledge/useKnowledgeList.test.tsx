import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mobileKnowledgeList, type MobileKnowledgePage, type MobileNoteSummary } from "@/lib/api/mobileKnowledge";
import { useKnowledgeList } from "./useKnowledgeList";

vi.mock("@/lib/api/mobileKnowledge", () => ({ mobileKnowledgeList: vi.fn() }));
const item = (id: string): MobileNoteSummary => ({ id, title: id, excerpt: "正文片段", updated_at: "", folder_id: null, folder_name: null, tags: [], common: false, last_access_at: null, reading_position: 0 });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(mobileKnowledgeList).mockResolvedValue({ items: [], has_more: false }); });
afterEach(cleanup);

it("discards a late search response after a new query has completed", async () => {
  let older!: (value: MobileKnowledgePage) => void;
  vi.mocked(mobileKnowledgeList).mockImplementation(options => options?.query === "旧" ? new Promise(resolve => { older = resolve; }) : Promise.resolve({ items: [item("新结果")], has_more: false }));
  const h = renderHook(({ query }) => useKnowledgeList(true, { query }), { initialProps: { query: "旧" } });
  await waitFor(() => expect(older).toBeTypeOf("function"));
  h.rerender({ query: "新" });
  await waitFor(() => expect(h.result.current.items[0]?.id).toBe("新结果"));
  await act(async () => older({ items: [item("旧结果")], has_more: false }));
  expect(h.result.current.items[0].id).toBe("新结果");
});
it("keeps already loaded rows visible when fetching the next page fails", async () => {
  vi.mocked(mobileKnowledgeList).mockResolvedValueOnce({ items: [item("已有资料")], has_more: true }).mockRejectedValueOnce(new Error("db read failed"));
  const h = renderHook(() => useKnowledgeList(true, {}));
  await waitFor(() => expect(h.result.current.items.length).toBe(1));
  await act(async () => { await h.result.current.more(); });
  expect(h.result.current.items[0].id).toBe("已有资料");
  expect(h.result.current.error).not.toBe("");
  expect(mobileKnowledgeList).toHaveBeenLastCalledWith({ offset: 1 });
});
it("does not request data while hidden and cancels late state changes", async () => {
  const h = renderHook(({ active }) => useKnowledgeList(active, {}), { initialProps: { active: false } });
  expect(mobileKnowledgeList).not.toHaveBeenCalled();
  h.rerender({ active: true });
  await waitFor(() => expect(mobileKnowledgeList).toHaveBeenCalledTimes(1));
  h.rerender({ active: false });
  expect(h.result.current.loading).toBe(false);
});

it("keeps loaded pages when switching away and refreshes the whole loaded range", async () => {
  vi.mocked(mobileKnowledgeList).mockImplementation(async options => ({ items: Array.from({ length: 20 }, (_, index) => item(`资料${(options?.offset || 0) + index}`)), has_more: true }));
  const h = renderHook(({ active }) => useKnowledgeList(active, {}), { initialProps: { active: true } });
  await waitFor(() => expect(h.result.current.items.length).toBe(20));
  await act(async () => { await h.result.current.more(); });
  expect(h.result.current.items.length).toBe(40);
  const reads = vi.mocked(mobileKnowledgeList).mock.calls.length;
  h.rerender({ active: false }); h.rerender({ active: true });
  expect(h.result.current.items.length).toBe(40);
  expect(mobileKnowledgeList).toHaveBeenCalledTimes(reads);
  act(() => h.result.current.refresh());
  await waitFor(() => expect(h.result.current.loading).toBe(false));
  expect(h.result.current.items.length).toBe(40);
  expect(vi.mocked(mobileKnowledgeList).mock.calls.slice(-2).map(([options]) => options?.offset)).toEqual([0, 20]);
});

it("does not present old-scope results or skip page one after a new search fails", async () => {
  vi.mocked(mobileKnowledgeList).mockResolvedValueOnce({ items: [item("旧范围")], has_more: true }).mockRejectedValueOnce(new Error("new query failed"));
  const h = renderHook(({ query }) => useKnowledgeList(true, { query }), { initialProps: { query: "旧" } });
  await waitFor(() => expect(h.result.current.items.length).toBe(1));
  h.rerender({ query: "新" });
  await waitFor(() => expect(h.result.current.error).not.toBe(""));
  expect(h.result.current.items).toEqual([]); expect(h.result.current.hasMore).toBe(false);
  await act(async () => { await h.result.current.more(); });
  expect(mobileKnowledgeList).toHaveBeenCalledTimes(2);
  act(() => h.result.current.refresh());
  await waitFor(() => expect(mobileKnowledgeList).toHaveBeenCalledTimes(3));
  expect(mobileKnowledgeList).toHaveBeenLastCalledWith({ query: "新", offset: 0 });
});
