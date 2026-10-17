import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MotionGlobalConfig } from "framer-motion";
import { InterfaceMotion } from "./InterfaceMotion";
import { useDialogAnim } from "@/lib/dialogMotion";
import { setMotionPreference } from "@/lib/motionPreference";

vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));
const changes = new Set<(event: MediaQueryListEvent) => void>();
beforeEach(() => {
  setMotionPreference(true);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => changes.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => changes.delete(listener),
  } as unknown as MediaQueryList);
});
afterEach(() => { cleanup(); changes.clear(); setMotionPreference(true); vi.restoreAllMocks(); });
function DialogProbe() {
  const anim = useDialogAnim();
  return <output>{JSON.stringify(anim.panel)}</output>;
}

it("the application switch covers explicit Framer transitions and CSS", () => {
  render(<InterfaceMotion><DialogProbe /></InterfaceMotion>);
  expect(document.documentElement.dataset.interfaceMotion).toBe("full");
  act(() => setMotionPreference(false));
  expect(document.documentElement.dataset.interfaceMotion).toBe("off");
  expect(MotionGlobalConfig.skipAnimations).toBe(true);
  expect(JSON.parse(screen.getByRole("status").textContent!).transition.duration).toBe(0);
});

it("live OS changes remove spatial motion while retaining opacity feedback", () => {
  render(<InterfaceMotion><DialogProbe /></InterfaceMotion>);
  act(() => changes.forEach(listener => listener({ matches: true } as MediaQueryListEvent)));
  const panel = JSON.parse(screen.getByRole("status").textContent!);
  expect(document.documentElement.dataset.interfaceMotion).toBe("reduced");
  expect(panel.initial).toEqual({ opacity: 0 });
  expect(panel.transition.duration).toBe(0.15);
});

it("a hidden document skips new animations and cleans up its window policy", () => {
  const { unmount } = render(<InterfaceMotion><DialogProbe /></InterfaceMotion>);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(document.documentElement.dataset.interfaceMotion).toBe("hidden");
  expect(document.documentElement.classList.contains("no-anim")).toBe(false);
  expect(MotionGlobalConfig.skipAnimations).toBe(true);
  unmount();
  expect(MotionGlobalConfig.skipAnimations).toBe(false);
  expect(document.documentElement.dataset.interfaceMotion).toBeUndefined();
});
