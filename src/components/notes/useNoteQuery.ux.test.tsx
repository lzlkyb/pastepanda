import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNoteQuery } from "./useNoteQuery";
import { noteList, noteSearch, type Note } from "@/lib/api";

vi.mock("@/hooks/useNoteDialogClosed", () => ({ useNoteDialogClosed: () => {} }));
vi.mock("@/lib/api", () => ({
  noteList: vi.fn(), noteSearch: vi.fn(), noteCountFiltered: vi.fn(async () => 100),
  noteGroupCounts: vi.fn(async () => new Map()), folderList: vi.fn(async () => []),
  folderUnfiledCount: vi.fn(async () => 0), folderMaxDepth: vi.fn(async () => 4), noteCountDeleted: vi.fn(async () => 0),
}));
const rows = (id: string) => [{ id, title: id }] as Note[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(noteList).mockReset().mockResolvedValue(rows("initial"));
  vi.mocked(noteSearch).mockReset().mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(210); }); };

it("a slow old query cannot replace a newly selected folder", async () => {
  let resolve!: (value: Note[]) => void;
  vi.mocked(noteList).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(rows("new-folder"));
  const { result } = renderHook(() => useNoteQuery());
  await tick();
  act(() => result.current.setFolderFilter("new-folder"));
  await tick();
  await act(async () => { resolve(rows("old-folder")); });
  expect(result.current.notes).toEqual(rows("new-folder"));
});

it("an old next page cannot append to new search results", async () => {
  const { result } = renderHook(() => useNoteQuery());
  await tick();
  let resolve!: (value: Note[]) => void;
  vi.mocked(noteList).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadMore(); });
  act(() => result.current.setKeyword("new"));
  vi.mocked(noteSearch).mockResolvedValue(rows("new-result"));
  await tick();
  await act(async () => { resolve(rows("old-page")); await pending; });
  expect(result.current.notes).toEqual(rows("new-result"));
});

it("rapid repeated load-more requests only fetch one page", async () => {
  const { result } = renderHook(() => useNoteQuery());
  await tick();
  let resolve!: (value: Note[]) => void;
  vi.mocked(noteList).mockClear().mockImplementation(() => new Promise(done => { resolve = done; }));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.loadMore(); second = result.current.loadMore(); });
  expect(noteList).toHaveBeenCalledTimes(1);
  await act(async () => { resolve([]); await first; await second; });
});
