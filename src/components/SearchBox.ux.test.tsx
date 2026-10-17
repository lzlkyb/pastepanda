import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SearchBox } from "./SearchBox";
import { useAppStore } from "@/stores/appStore";
import { semanticSearch } from "@/lib/api/semantic";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
import type { SemanticHit } from "@/lib/api/semantic";

vi.mock("@/lib/api/semantic", () => ({ semanticSearch: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  setAiAvailable(true);
  useAppStore.setState({ searchKeyword: "", semanticHits: [], searchHistory: [] });
  vi.mocked(semanticSearch).mockReset().mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); setAiAvailable(false); });
function enter(value: string) {
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}
const hit = (id: string) => [{ historyId: id, text: id }] as SemanticHit[];

it("an older search response cannot replace the newest results", async () => {
  let resolveOld!: (value: SemanticHit[]) => void;
  vi.mocked(semanticSearch).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce(hit("new"));
  render(<SearchBox />);
  enter("old");
  await act(async () => { enter("new"); });
  await act(async () => { resolveOld(hit("old")); });
  expect(useAppStore.getState().semanticHits).toEqual(hit("new"));
});

it("clearing search invalidates a pending semantic response", async () => {
  let resolve!: (value: SemanticHit[]) => void;
  vi.mocked(semanticSearch).mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<SearchBox />);
  enter("pending");
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "" } });
  await act(async () => { resolve(hit("stale")); });
  expect(useAppStore.getState().semanticHits).toEqual([]);
});

it("switching away cancels the debounced query", async () => {
  const view = render(<SearchBox />);
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "pending" } });
  view.unmount();
  await act(async () => { vi.advanceTimersByTime(250); });
  expect(useAppStore.getState().searchKeyword).toBe("");
  expect(semanticSearch).not.toHaveBeenCalled();
});

it("Chinese candidate confirmation does not submit an unfinished search", () => {
  render(<SearchBox />);
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "zhong" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true, keyCode: 229 });
  expect(useAppStore.getState().searchHistory).toEqual([]);
});

it("disabled AI does not issue semantic requests", async () => {
  setAiAvailable(false);
  render(<SearchBox />);
  await act(async () => { enter("keyword only"); });
  expect(semanticSearch).not.toHaveBeenCalled();
  expect(useAppStore.getState().searchKeyword).toBe("keyword only");
});

it("an external search reset cancels pending input", async () => {
  useAppStore.setState({ searchKeyword: "old" });
  render(<SearchBox />);
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "pending" } });
  act(() => useAppStore.getState().setSearchKeyword(""));
  await act(async () => { vi.advanceTimersByTime(250); });
  expect(useAppStore.getState().searchKeyword).toBe("");
  expect(semanticSearch).not.toHaveBeenCalled();
});
