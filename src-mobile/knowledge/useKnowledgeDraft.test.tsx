import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api/mobileKnowledge";
import { useKnowledgeDraft } from "./useKnowledgeDraft";

vi.mock("@/lib/api/mobileKnowledge", () => ({
  mobileKnowledgeDraftGet: vi.fn(), mobileKnowledgeDraftPut: vi.fn(), mobileKnowledgeDraftClear: vi.fn(), mobileKnowledgeDraftCommit: vi.fn(),
}));
const note = { id: "saved", title: "备忘", content: "内容", history_id: null, created_at: "", updated_at: "", source_agent: "", folder_id: null, summary: null, daily_date: null, tags: [] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.mobileKnowledgeDraftGet).mockResolvedValue(null);
  vi.mocked(api.mobileKnowledgeDraftPut).mockImplementation(async draft => draft);
  vi.mocked(api.mobileKnowledgeDraftClear).mockResolvedValue(undefined);
  vi.mocked(api.mobileKnowledgeDraftCommit).mockResolvedValue(note);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("restores a durable draft once and never replaces it when the tab becomes active again", async () => {
  vi.mocked(api.mobileKnowledgeDraftGet).mockResolvedValue({ id: "draft", revision: 7, title: "上次记录", content: "已有内容" });
  const h = renderHook(({ active }) => useKnowledgeDraft(active), { initialProps: { active: true } });
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  act(() => h.result.current.update("content", "继续补充"));
  h.rerender({ active: false }); h.rerender({ active: true });
  await waitFor(() => expect(api.mobileKnowledgeDraftPut).toHaveBeenCalled());
  expect(h.result.current.draft?.content).toBe("继续补充");
  expect(api.mobileKnowledgeDraftGet).toHaveBeenCalledTimes(1);
});

it("flushes the latest title and content before commit, sharing one stable id", async () => {
  const h = renderHook(() => useKnowledgeDraft(true));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { await h.result.current.begin(); });
  const id = h.result.current.draft!.id;
  act(() => { h.result.current.update("title", "客户会议"); h.result.current.update("content", "核对交付范围"); });
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeDraftPut).toHaveBeenLastCalledWith(expect.objectContaining({ id, revision: 3, title: "客户会议", content: "核对交付范围" }));
  expect(api.mobileKnowledgeDraftCommit).toHaveBeenCalledWith(id, 3);
  expect(h.result.current.draft).toBeNull();
});

it("retains input when storage fails and retries without creating a new id", async () => {
  const h = renderHook(() => useKnowledgeDraft(true));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { await h.result.current.begin(); });
  const id = h.result.current.draft!.id;
  act(() => h.result.current.update("content", "不能丢失的输入"));
  vi.mocked(api.mobileKnowledgeDraftPut).mockRejectedValueOnce(new Error("database or disk is full"));
  await act(async () => { await h.result.current.save(); });
  expect(h.result.current.error).toMatch(/存储空间不足/);
  expect(h.result.current.draft?.content).toBe("不能丢失的输入");
  expect(api.mobileKnowledgeDraftCommit).not.toHaveBeenCalled();
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeDraftCommit).toHaveBeenCalledWith(id, 2);
});

it("reconciles a lost commit reply by retrying commit, without recreating or rewriting the draft", async () => {
  vi.mocked(api.mobileKnowledgeDraftCommit).mockRejectedValueOnce(new Error("reply lost"));
  const h = renderHook(() => useKnowledgeDraft(true));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { await h.result.current.begin(); });
  act(() => h.result.current.update("content", "保存这一份"));
  await act(async () => { await h.result.current.save(); });
  expect(h.result.current.locked).toBe(true);
  const writes = vi.mocked(api.mobileKnowledgeDraftPut).mock.calls.length;
  act(() => h.result.current.update("content", "不能覆盖未确认版本"));
  expect(h.result.current.draft?.content).toBe("保存这一份");
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeDraftPut).toHaveBeenCalledTimes(writes);
  expect(api.mobileKnowledgeDraftCommit).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.mobileKnowledgeDraftCommit).mock.calls[0]).toEqual(vi.mocked(api.mobileKnowledgeDraftCommit).mock.calls[1]);
});

it("blocks new recording while the previous draft cannot be read", async () => {
  vi.mocked(api.mobileKnowledgeDraftGet).mockRejectedValueOnce(new Error("read failed"));
  const h = renderHook(() => useKnowledgeDraft(true));
  await waitFor(() => expect(h.result.current.error).not.toBe(""));
  await act(async () => { expect(await h.result.current.begin()).toBe(false); });
  expect(api.mobileKnowledgeDraftPut).not.toHaveBeenCalled();
  await act(async () => { await h.result.current.retryLoad(); });
  expect(h.result.current.ready).toBe(true);
});

it("flushes immediately on backgrounding, rather than waiting for the autosave timer", async () => {
  const h = renderHook(() => useKnowledgeDraft(true));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { await h.result.current.begin(); });
  act(() => h.result.current.update("content", "退后台前的输入"));
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  expect(api.mobileKnowledgeDraftPut).toHaveBeenLastCalledWith(expect.objectContaining({ content: "退后台前的输入" }));
});

it("deduplicates simultaneous flushes and can commit an acknowledged durable version", async () => {
  const h = renderHook(() => useKnowledgeDraft(true));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { await h.result.current.begin(); });
  act(() => h.result.current.update("content", "同版本只写一次"));
  const before = vi.mocked(api.mobileKnowledgeDraftPut).mock.calls.length;
  await act(async () => { await Promise.all([h.result.current.flush(), h.result.current.flush()]); });
  expect(api.mobileKnowledgeDraftPut).toHaveBeenCalledTimes(before + 1);
  vi.mocked(api.mobileKnowledgeDraftPut).mockRejectedValueOnce(new Error("redundant write fails"));
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeDraftCommit).toHaveBeenCalledTimes(1);
  expect(h.result.current.draft).toBeNull();
});

it("rejects a collection retry bound to another draft without committing current input", async () => {
  const h = renderHook(() => useKnowledgeDraft(true));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { await h.result.current.begin(); });
  act(() => h.result.current.update("content", "另一份草稿仍保留"));
  await act(async () => { expect(await h.result.current.save("old-collection-id")).toBeNull(); });
  expect(api.mobileKnowledgeDraftCommit).not.toHaveBeenCalled();
  expect(h.result.current.draft?.content).toBe("另一份草稿仍保留");
  expect(h.result.current.error).toMatch(/原收集草稿已变化/);
});
