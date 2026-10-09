import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useRcSessionAudio } from "./useRcSessionAudio";
const { toggle } = vi.hoisted(() => ({ toggle: vi.fn() }));
vi.mock("@/lib/api/rc", () => ({ rcAudioToggle: toggle }));
vi.mock("@/hooks/useRcAudio", () => ({ useRcAudio: vi.fn() }));
beforeEach(() => { toggle.mockReset().mockResolvedValue(undefined); });
it("stops listening on a host capture error and permits an explicit retry", () => {
  const toast = vi.fn();
  const { result, rerender } = renderHook(({ error }) => useRcSessionAudio("session", toast, error), {
    initialProps: { error: null as string | null },
  });
  expect(result.current.audioOn).toBe(true);
  rerender({ error: "系统声音采集失败" });
  expect(result.current.audioOn).toBe(false);
  expect(toast).toHaveBeenCalledWith("系统声音采集失败", "error");
  expect(toggle).toHaveBeenLastCalledWith(false);
  act(() => result.current.toggleAudio());
  expect(result.current.audioOn).toBe(true);
  expect(toggle).toHaveBeenLastCalledWith(true);
});
