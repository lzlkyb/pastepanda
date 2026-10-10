import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileNavigation } from "./useMobileNavigation";

vi.mock("./useMobileBack", () => ({ useMobileBack: vi.fn() }));
afterEach(() => { cleanup(); delete document.body.dataset.mobileSheets; vi.restoreAllMocks(); });

it("新增第四目的地不需要索引和页数，连续点击直接进入最后选择", () => {
  const ids = ["devices", "files", "knowledge", "settings"] as const;
  const h = renderHook(() => useMobileNavigation(ids, "devices", true));
  act(() => { h.result.current.selectTab("knowledge"); h.result.current.selectTab("settings"); });
  expect(h.result.current.tab).toBe("settings");
  act(() => h.result.current.selectTab("knowledge"));
  expect(h.result.current.tab).toBe("knowledge");
});

it("弹层退出后才导航；收起期间的新选择替代旧目标", async () => {
  const h = renderHook(() => useMobileNavigation(["devices", "files", "settings"], "devices", true));
  document.body.dataset.mobileSheets = "1";
  act(() => { h.result.current.selectTab("files"); h.result.current.selectTab("settings"); });
  expect(h.result.current.tab).toBe("devices");
  await act(async () => { delete document.body.dataset.mobileSheets; await Promise.resolve(); });
  expect(h.result.current.tab).toBe("settings");
});

it("进入远控后丢弃排队导航，弹层迟到清理不能改变返回页面", async () => {
  const h = renderHook(({ active }) => useMobileNavigation(["devices", "files"], "devices", active), { initialProps: { active: true } });
  document.body.dataset.mobileSheets = "1";
  act(() => h.result.current.selectTab("files"));
  h.rerender({ active: false });
  await act(async () => { delete document.body.dataset.mobileSheets; await Promise.resolve(); });
  h.rerender({ active: true });
  expect(h.result.current.tab).toBe("devices");
});

it("弹层在后台完成退出后，回到前台继续已选择的导航", async () => {
  const h = renderHook(() => useMobileNavigation(["devices", "files"], "devices", true));
  document.body.dataset.mobileSheets = "1";
  act(() => h.result.current.selectTab("files"));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => { delete document.body.dataset.mobileSheets; await Promise.resolve(); });
  expect(h.result.current.tab).toBe("devices");
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(h.result.current.tab).toBe("files");
});
