import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mobileKnowledgeShareList, mobileKnowledgeShareListen, mobileKnowledgeShareAck,
  mobileKnowledgeSharePickImages, type MobileKnowledgeInbox, type MobileKnowledgeIncoming,
} from "@/lib/api/mobileKnowledgeShare";
import { useKnowledgeInbox } from "./useKnowledgeInbox";

vi.mock("@/lib/api/mobileKnowledgeShare", () => ({
  mobileKnowledgeShareList: vi.fn(), mobileKnowledgeShareListen: vi.fn(),
  mobileKnowledgeShareAck: vi.fn(), mobileKnowledgeSharePickImages: vi.fn(),
}));
const list = vi.mocked(mobileKnowledgeShareList);
const listen = vi.mocked(mobileKnowledgeShareListen);
const ack = vi.mocked(mobileKnowledgeShareAck);
const pick = vi.mocked(mobileKnowledgeSharePickImages);
const item = { id: "incoming", title: "收集", text: "内容", images: ["pp-asset:photo.png"], status: "ready" as const, message: "待确认", created_at: 10 };
const snapshot = (items: MobileKnowledgeIncoming[] = [item], processing = false): MobileKnowledgeInbox => ({ items, processing, notice: "" });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
let hidden = false;
let changed: () => void;
let unregister = vi.fn(async () => {});
const nativeListener = (remove: () => Promise<void> = unregister) => ({ plugin: "knowledge-share", event: "incoming", channelId: 1, unregister: remove });

beforeEach(() => {
  hidden = false; Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  list.mockReset(); listen.mockReset(); ack.mockReset(); pick.mockReset();
  unregister = vi.fn(async () => {});
  list.mockResolvedValue(snapshot()); ack.mockResolvedValue(undefined); pick.mockResolvedValue({ status: "cancelled" });
  listen.mockImplementation(async callback => { changed = callback; return nativeListener(); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("reads persisted cold-start content and reads again when native subscription becomes available", async () => {
  const subscription = deferred<Awaited<ReturnType<typeof mobileKnowledgeShareListen>>>();
  listen.mockReturnValue(subscription.promise);
  list.mockResolvedValueOnce(snapshot([], true));
  const { result } = renderHook(() => useKnowledgeInbox());
  await waitFor(() => expect(result.current.processing).toBe(true));
  // Native finished before JS could subscribe; no event can wake this hook.
  await act(async () => { subscription.resolve(nativeListener()); });
  await waitFor(() => expect(result.current.items).toEqual([item]));
  expect(result.current.processing).toBe(false); expect(result.current.ready).toBe(true);
});

it("recovers missed processing completion with bounded checks and stops all checks while hidden", async () => {
  vi.useFakeTimers();
  listen.mockRejectedValue(new Error("native listener unavailable"));
  list.mockResolvedValue(snapshot([], true));
  const { result } = renderHook(() => useKnowledgeInbox()); await flush();
  expect(result.current.processing).toBe(true);
  list.mockResolvedValue(snapshot());
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(result.current.items).toEqual([item]); expect(result.current.processing).toBe(false);
  const completed = list.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(list).toHaveBeenCalledTimes(completed);
  list.mockResolvedValue(snapshot([], true));
  await act(async () => { await result.current.refresh(); });
  hidden = true; act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  const beforeBackground = list.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(list).toHaveBeenCalledTimes(beforeBackground);
});

it("stops checking a stuck processing job after 15 seconds and keeps truthful pending state", async () => {
  vi.useFakeTimers(); listen.mockRejectedValue(new Error("unsupported")); list.mockResolvedValue(snapshot([], true));
  const { result } = renderHook(() => useKnowledgeInbox()); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_500); });
  expect(result.current.error).toContain("仍在收集"); expect(result.current.processing).toBe(true);
  const stopped = list.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(list).toHaveBeenCalledTimes(stopped);
});

it("isolates StrictMode's obsolete read from the current lifecycle and unregisters a late listener", async () => {
  const oldRead = deferred<MobileKnowledgeInbox>();
  const oldListener = deferred<Awaited<ReturnType<typeof mobileKnowledgeShareListen>>>();
  const obsoleteUnregister = vi.fn(async () => {});
  list.mockReturnValueOnce(oldRead.promise); listen.mockReturnValueOnce(oldListener.promise);
  const { result } = renderHook(() => useKnowledgeInbox(), { wrapper: StrictMode });
  await waitFor(() => expect(result.current.items).toEqual([item]));
  await act(async () => {
    oldRead.resolve(snapshot([{ ...item, id: "obsolete" }]));
    oldListener.resolve(nativeListener(obsoleteUnregister));
  });
  expect(result.current.items).toEqual([item]); expect(obsoleteUnregister).toHaveBeenCalledOnce();
});

it("does not turn picker cancellation, rejected reads or invalid images into collection success", async () => {
  const { result } = renderHook(() => useKnowledgeInbox()); await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { expect(await result.current.pickImages()).toBe(false); });
  expect(result.current.items).toEqual([item]); expect(result.current.error).toBe("");
  pick.mockResolvedValue({ status: "collected", incomingId: "new" }); list.mockRejectedValue(new Error("读取失败"));
  await act(async () => { expect(await result.current.pickImages()).toBe(false); });
  expect(result.current.error).toContain("请重试"); expect(result.current.items).toEqual([item]);
  list.mockResolvedValue(snapshot([{ ...item, id: "bad", images: [], status: "error", message: "格式无效" }]));
  await act(async () => { expect(await result.current.pickImages()).toBe(false); });
});

it("only reports collected when a new validated image item is actually readable", async () => {
  const { result } = renderHook(() => useKnowledgeInbox()); await waitFor(() => expect(result.current.ready).toBe(true));
  pick.mockResolvedValue({ status: "collected", incomingId: "new" }); list.mockResolvedValue(snapshot([item, { ...item, id: "new" }]));
  await act(async () => { expect(await result.current.pickImages()).toBe(true); });
});

it("failed acknowledgement preserves pending contents and exposes the error", async () => {
  const { result } = renderHook(() => useKnowledgeInbox()); await waitFor(() => expect(result.current.ready).toBe(true));
  ack.mockRejectedValue(new Error("清理失败"));
  await act(async () => { expect(await result.current.acknowledge(item.id)).toBe(false); });
  expect(result.current.items).toEqual([item]); expect(result.current.error).toContain("请重试"); expect(result.current.busy).toBe(false);
});

it("initial read failure is not a verified empty inbox and retry restores readiness", async () => {
  list.mockRejectedValue(new Error("读取失败"));
  const { result } = renderHook(() => useKnowledgeInbox());
  await waitFor(() => expect(result.current.error).toContain("请重试"));
  expect(result.current.ready).toBe(false); expect(result.current.loading).toBe(false);
  list.mockResolvedValue(snapshot([]));
  await act(async () => { expect(await result.current.refresh()).toBe(true); });
  expect(result.current.ready).toBe(true); expect(result.current.items).toEqual([]); expect(result.current.error).toBe("");
});

it("does not resurrect consumed items from an older list snapshot when acknowledgement succeeds", async () => {
  const { result } = renderHook(() => useKnowledgeInbox()); await waitFor(() => expect(result.current.ready).toBe(true));
  const stale = deferred<MobileKnowledgeInbox>();
  const fresh = deferred<MobileKnowledgeInbox>();
  list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
  let operation!: Promise<boolean>;
  act(() => { void result.current.refresh(); operation = result.current.acknowledge(item.id); });
  await flush(); expect(result.current.items).toEqual([]);
  await act(async () => { stale.resolve(snapshot()); });
  expect(result.current.items).toEqual([]);
  await act(async () => { fresh.resolve(snapshot([])); expect(await operation).toBe(true); });
  expect(result.current.items).toEqual([]);
});

it("event bursts await the coalesced follow-up read instead of returning stale contents", async () => {
  const { result } = renderHook(() => useKnowledgeInbox()); await waitFor(() => expect(result.current.ready).toBe(true));
  const blocked = deferred<MobileKnowledgeInbox>(); const afterEvent = { ...item, id: "after-event" };
  list.mockReturnValueOnce(blocked.promise).mockResolvedValue(snapshot([afterEvent]));
  let refresh!: Promise<boolean>;
  act(() => { refresh = result.current.refresh(); changed(); });
  await act(async () => { blocked.resolve(snapshot([])); expect(await refresh).toBe(true); });
  expect(result.current.items).toEqual([afterEvent]);
});

it("unmount clears the processing timer and unregisters even a listener that resolves afterwards", async () => {
  vi.useFakeTimers(); const late = deferred<Awaited<ReturnType<typeof mobileKnowledgeShareListen>>>();
  listen.mockReturnValue(late.promise); list.mockResolvedValue(snapshot([], true));
  const { unmount } = renderHook(() => useKnowledgeInbox()); await flush(); unmount();
  const reads = list.mock.calls.length;
  await act(async () => { late.resolve(nativeListener()); await vi.advanceTimersByTimeAsync(30_000); });
  expect(unregister).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledTimes(reads);
});
