import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useKnowledgeCollection } from "./useKnowledgeCollection";

/**
 * 放弃一次收集 = 清掉待收集列表里的那条。清理失败时 `acknowledge` 返回 false
 * 而不是 reject ⇒ 没有全局兜底，也没有 toast：这里必须自己喊话，否则用户点了
 * 「确认放弃」看到内容还在、界面毫无反应。
 */
type Params = Parameters<typeof useKnowledgeCollection>[0];
const draft = { ready: true, draft: null, saving: false, locked: false, error: "", update: vi.fn(), begin: vi.fn(), flush: vi.fn(), save: vi.fn(), discard: vi.fn(), retryLoad: vi.fn() } as unknown as Params["draft"];
const edit = { ...draft } as unknown as Params["edit"];

it("a failed collection cleanup says so instead of silently doing nothing", async () => {
  const acknowledge = vi.fn().mockResolvedValue(false);
  const inbox = { items: [], picking: false, acknowledge } as unknown as Params["inbox"];
  const hook = renderHook(() => useKnowledgeCollection({
    active: true, editing: false, maintaining: false, draft, edit, inbox,
    setEditing: vi.fn(), setMaintaining: vi.fn(), setSelected: vi.fn(), onCaptured: vi.fn(),
  }));
  await act(async () => { expect(await hook.result.current.discard("share-a")).toBe(false); });
  expect(acknowledge).toHaveBeenCalledWith("share-a");
  expect(hook.result.current.collectionError).toContain("仍保留在待收集列表");
});

it("a confirmed cleanup closes the collection without an error", async () => {
  const acknowledge = vi.fn().mockResolvedValue(true);
  const inbox = { items: [], picking: false, acknowledge } as unknown as Params["inbox"];
  const hook = renderHook(() => useKnowledgeCollection({
    active: true, editing: false, maintaining: false, draft, edit, inbox,
    setEditing: vi.fn(), setMaintaining: vi.fn(), setSelected: vi.fn(), onCaptured: vi.fn(),
  }));
  await act(async () => { expect(await hook.result.current.discard("share-a")).toBe(true); });
  expect(hook.result.current.collectionError).toBe("");
  expect(hook.result.current.incomingId).toBeNull();
});
