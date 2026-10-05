import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useMobileReceiveDir } from "./useMobileReceiveDir";
const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/api/rcFile", () => ({ rcFileDefaultDir: api.get, rcFileReceiveDirSet: api.set }));
beforeEach(() => {
  api.get.mockReset();
  api.set.mockReset();
});

it("会话未打开不读目录，重新打开校准；旧结果不覆盖新目录", async () => {
  let old!: (path: string) => void;
  api.get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValueOnce("/new");
  const h = renderHook(({ active }) => useMobileReceiveDir(active), { initialProps: { active: false } });
  expect(api.get).not.toHaveBeenCalled();
  h.rerender({ active: true });
  h.rerender({ active: false });
  h.rerender({ active: true });
  await waitFor(() => expect(h.result.current.dir).toBe("/new"));
  await act(async () => old("/old"));
  expect(h.result.current.dir).toBe("/new");
});
it("重置提交期间不重复写配置，失败清空可用目录且保留恢复入口", async () => {
  api.get.mockResolvedValue("/old");
  let reject!: (error: string) => void;
  api.set.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const h = renderHook(() => useMobileReceiveDir());
  await waitFor(() => expect(h.result.current.dir).toBe("/old"));
  let pending!: Promise<boolean>;
  act(() => {
    pending = h.result.current.reset();
  });
  await act(async () => {
    expect(await h.result.current.reset()).toBe(false);
  });
  expect(api.set).toHaveBeenCalledTimes(1);
  await act(async () => {
    reject("创建接收目录失败：Permission denied");
    await pending;
  });
  expect(h.result.current.dir).toBeNull();
  expect(h.result.current.canReset).toBe(true);
  expect(h.result.current.busy).toBe(false);
});
it("重置时退出并重新打开，仍接收本批结果，恢复状态不会一直转圈", async () => {
  api.get.mockResolvedValue("/old");
  let finish!: (path: string) => void;
  api.set.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const h = renderHook(({ active }) => useMobileReceiveDir(active), { initialProps: { active: true } });
  await waitFor(() => expect(h.result.current.dir).toBe("/old"));
  let pending!: Promise<boolean>;
  act(() => {
    pending = h.result.current.reset();
  });
  h.rerender({ active: false });
  h.rerender({ active: true });
  await act(async () => {
    finish("/new");
    await pending;
  });
  expect(h.result.current.dir).toBe("/new");
  expect(h.result.current.busy).toBe(false);
});
