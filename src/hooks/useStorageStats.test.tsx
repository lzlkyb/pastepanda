import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStorageStats } from "./useStorageStats";
import * as api from "@/lib/api/storage";
import { storageDatabase, storageOverview } from "@/__tests__/fixtures/storage";

vi.mock("./useWindowVisible", () => ({ useWindowVisible: () => true }));
vi.mock("@/lib/api/storage", () => ({
  getStorageOverview: vi.fn(), getStorageDatabase: vi.fn(),
  cancelStorageRequest: vi.fn(async () => {}),
}));
let intersect: (entries: { isIntersecting: boolean }[]) => void;
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: typeof intersect) { intersect = cb; }
    observe() {} disconnect() {}
  });
  vi.mocked(api.getStorageOverview).mockResolvedValue(storageOverview);
  vi.mocked(api.getStorageDatabase).mockResolvedValue(storageDatabase);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const ref = { current: document.createElement("div") };

it("不查看存储区域不发请求，首次可见先元数据再目录扫描", async () => {
  const { result } = renderHook(() => useStorageStats(ref));
  expect(api.getStorageOverview).not.toHaveBeenCalled();
  await act(async () => intersect([{ isIntersecting: true }]));
  expect(api.getStorageOverview).toHaveBeenNthCalledWith(1, expect.any(String), false);
  expect(api.getStorageOverview).toHaveBeenNthCalledWith(2, expect.any(String), true);
  expect(result.current.overview).toEqual(storageOverview);
});

it("刷新失败保留旧值与错误，后续可重试", async () => {
  const { result } = renderHook(() => useStorageStats(ref));
  await act(async () => intersect([{ isIntersecting: true }]));
  vi.mocked(api.getStorageOverview).mockRejectedValueOnce(new Error("denied"));
  await act(async () => result.current.refresh());
  expect(result.current.overview).toEqual(storageOverview);
  expect(result.current.error).toContain("失败");
  await act(async () => result.current.refresh());
  expect(result.current.error).toBe("");
});

it("取消中的旧响应不能覆盖新结果，离开区域停止请求", async () => {
  let finish: (value: typeof storageOverview) => void = () => {};
  vi.mocked(api.getStorageOverview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useStorageStats(ref));
  await act(async () => intersect([{ isIntersecting: true }]));
  act(() => result.current.cancel());
  expect(api.cancelStorageRequest).toHaveBeenCalled();
  await act(async () => result.current.refresh());
  await act(async () => finish({ ...storageOverview, total_bytes: 1 }));
  expect(result.current.overview?.total_bytes).toBe(storageOverview.total_bytes);
  act(() => intersect([{ isIntersecting: false }]));
  expect(result.current.loading).toBe(false);
});

it("剪贴板到达只标记数据变化，完成清理才请求重扫", async () => {
  const { result } = renderHook(() => useStorageStats(ref));
  await act(async () => intersect([{ isIntersecting: true }]));
  vi.mocked(api.getStorageOverview).mockClear();
  act(() => window.dispatchEvent(new Event("counts-invalidated")));
  expect(result.current.stale).toBe(true);
  expect(api.getStorageOverview).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event("storage-usage-invalidated")));
  expect(api.getStorageOverview).toHaveBeenCalledTimes(2);
});
