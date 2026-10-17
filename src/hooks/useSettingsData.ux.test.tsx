import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsData } from "./useSettingsData";
import { DEFAULT_CONFIG } from "@/stores/appStore";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/api/chains", () => ({ chainList: vi.fn(async () => []) }));
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset().mockResolvedValue(undefined); });
it("file association detection failure ends loading and can be retried", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("registry denied"));
  const { result } = renderHook(() => useSettingsData({ config: DEFAULT_CONFIG, updateAndSave: vi.fn(async () => true), stats: null }));
  await act(async () => {});
  expect(result.current.mdAssoc).toBe("error");
  vi.mocked(invoke).mockResolvedValueOnce("registered");
  fireEventFocus();
  await act(async () => {});
  expect(result.current.mdAssoc).toBe("registered");
});
function fireEventFocus() { act(() => window.dispatchEvent(new Event("focus"))); }
