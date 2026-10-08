import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api/mobileKnowledgeEdit";
import { useKnowledgeEdit } from "./useKnowledgeEdit";

vi.mock("@/lib/api/mobileKnowledgeEdit", () => ({
  mobileKnowledgeEditGet: vi.fn(), mobileKnowledgeEditBegin: vi.fn(), mobileKnowledgeEditPut: vi.fn(),
  mobileKnowledgeEditCommit: vi.fn(), mobileKnowledgeEditCopy: vi.fn(), mobileKnowledgeEditClear: vi.fn(),
}));
const note = { id: "note", title: "原笔记", content: "原内容", created_at: "", updated_at: "", folder_id: null, tags: [], history_id: null, source_agent: "", summary: null, daily_date: null };
const draft: api.MobileKnowledgeEditDraft = { id: "draft", revision: 1, note_id: note.id, base_version: "immutable", base_note: note, title: note.title, content: note.content, folder_id: null, tag_ids: [], updated_at: "" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.mobileKnowledgeEditGet).mockResolvedValue(null);
  vi.mocked(api.mobileKnowledgeEditBegin).mockResolvedValue(draft);
  vi.mocked(api.mobileKnowledgeEditPut).mockImplementation(async d => d);
  vi.mocked(api.mobileKnowledgeEditCommit).mockResolvedValue({ status: "saved", note, relinked: 0 });
  vi.mocked(api.mobileKnowledgeEditCopy).mockResolvedValue({ status: "saved", note: { ...note, id: "copy" }, relinked: 0 });
  vi.mocked(api.mobileKnowledgeEditClear).mockResolvedValue(undefined);
});
afterEach(() => cleanup());
async function begin() {
  const h = renderHook(() => useKnowledgeEdit(true));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { await h.result.current.begin(note.id); }); return h;
}
it("flushes changed fields before CAS while retaining the immutable base", async () => {
  const h = await begin();
  act(() => { h.result.current.update("title", "修改标题"); h.result.current.update("content", "修改正文"); h.result.current.update("tag_ids", ["tag"]); });
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeEditPut).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 4, base_version: "immutable", base_note: note, title: "修改标题", content: "修改正文", tag_ids: ["tag"] }));
  expect(api.mobileKnowledgeEditCommit).toHaveBeenCalledWith("draft", 4);
  expect(h.result.current.draft).toBeNull();
});
it("retains input on a conflict and creates a copy only after explicit choice", async () => {
  const h = await begin();
  vi.mocked(api.mobileKnowledgeEditCommit).mockResolvedValue({ status: "conflict", latest: { ...note, content: "电脑的新内容" } });
  act(() => h.result.current.update("content", "手机修改"));
  await act(async () => { await h.result.current.save(); });
  expect(h.result.current.draft?.content).toBe("手机修改");
  expect(h.result.current.locked).toBe(false);
  expect(api.mobileKnowledgeEditCopy).not.toHaveBeenCalled();
  await act(async () => { const result = await h.result.current.save(true); expect(result?.copied).toBe(true); });
  expect(api.mobileKnowledgeEditCopy).toHaveBeenCalledWith("draft", 2);
});
it("lost copy reply retries the same copy even if normal save is pressed", async () => {
  const h = await begin();
  vi.mocked(api.mobileKnowledgeEditCopy).mockRejectedValueOnce("reply lost");
  await act(async () => { await h.result.current.save(true); });
  expect(h.result.current.locked).toBe(true);
  act(() => h.result.current.update("content", "不应覆盖待核对版本"));
  expect(h.result.current.draft?.content).toBe(note.content);
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeEditCopy).toHaveBeenCalledTimes(2);
  expect(api.mobileKnowledgeEditCommit).not.toHaveBeenCalled();
});
it("a confirmed category rejection unlocks selection while unknown errors stay locked", async () => {
  const h = await begin();
  vi.mocked(api.mobileKnowledgeEditCommit).mockRejectedValueOnce("MOBILE_EDIT_REJECTED:folder_missing");
  await act(async () => { await h.result.current.save(); });
  expect(h.result.current.locked).toBe(false);
  expect(h.result.current.error).toContain("重新选择文件夹");
  act(() => h.result.current.update("folder_id", "new-folder"));
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeEditCommit).toHaveBeenLastCalledWith("draft", 2);
});
it("durable write failure retains editable input and does not attempt commit", async () => {
  const h = await begin();
  act(() => h.result.current.update("content", "不能丢失"));
  vi.mocked(api.mobileKnowledgeEditPut).mockRejectedValueOnce("database or disk is full");
  await act(async () => { await h.result.current.save(); });
  expect(api.mobileKnowledgeEditCommit).not.toHaveBeenCalled();
  expect(h.result.current.draft?.content).toBe("不能丢失");
  expect(h.result.current.locked).toBe(false);
  expect(h.result.current.error).toContain("存储空间不足");
});
it("cannot begin another note over a restored edit; background flush retains latest content", async () => {
  vi.mocked(api.mobileKnowledgeEditGet).mockResolvedValue(draft);
  const h = renderHook(({ active }) => useKnowledgeEdit(active), { initialProps: { active: true } });
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => { expect(await h.result.current.begin("other")).toBe(false); });
  expect(api.mobileKnowledgeEditBegin).not.toHaveBeenCalled();
  act(() => h.result.current.update("content", "最新修改")); h.rerender({ active: false });
  await waitFor(() => expect(api.mobileKnowledgeEditPut).toHaveBeenCalledWith(expect.objectContaining({ content: "最新修改" })));
});
it("allows title-only notes and preserves deleted drafts without reviving the note", async () => {
  const h = await begin();
  act(() => h.result.current.update("content", ""));
  vi.mocked(api.mobileKnowledgeEditCommit).mockResolvedValue({ status: "deleted" });
  await act(async () => { await h.result.current.save(); });
  expect(h.result.current.conflict?.status).toBe("deleted");
  expect(h.result.current.draft).not.toBeNull();
  expect(api.mobileKnowledgeEditCopy).not.toHaveBeenCalled();
});
