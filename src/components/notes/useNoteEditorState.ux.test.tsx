import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNoteEditorState } from "./useNoteEditorState";
import { noteCreate, type Note } from "@/lib/api";
import { confirmDialog } from "@/lib/confirm";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/confirm", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/lib/api", () => ({
  noteCreate: vi.fn(), noteUpdate: vi.fn(), noteSetFolder: vi.fn(), noteMarkdown: vi.fn(),
  fetchNoteHistoryIds: vi.fn(), noteGet: vi.fn(),
}));
beforeEach(() => { vi.mocked(confirmDialog).mockReset().mockResolvedValue(false); vi.mocked(noteCreate).mockReset(); });
afterEach(cleanup);
const target = { noteId: null, historyId: null, title: "笔记", content: "金额 100 元" };
it("even one changed digit is protected when switching notes", async () => {
  const { result } = renderHook(() => useNoteEditorState({ target, onClose: vi.fn() }));
  act(() => result.current.setContent("金额 900 元"));
  let allowed = true;
  await act(async () => { allowed = await result.current.guardSwitch(); });
  expect(allowed).toBe(false);
  expect(confirmDialog).toHaveBeenCalledOnce();
});
it("rapid save triggers cannot create the same note twice", async () => {
  let resolve!: (value: Note | null) => void;
  vi.mocked(noteCreate).mockImplementation(() => new Promise(done => { resolve = done; }));
  const { result } = renderHook(() => useNoteEditorState({ target, onClose: vi.fn() }));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => { first = result.current.save(); second = result.current.save(); });
  expect(noteCreate).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(null); await first; await second; });
});
