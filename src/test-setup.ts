import { vi } from "vitest";

// Business tests use reduced motion so assertions do not depend on animation timing.
// Motion tests replace this with a deterministic clock and explicitly test both paths.
// Build-tool crypto tests run in Node and have no browser window.
if (typeof window !== "undefined") Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
