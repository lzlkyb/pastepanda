import { vi } from "vitest";

// Business tests use reduced motion so assertions do not depend on animation timing.
// Motion tests replace this with a deterministic clock and explicitly test both paths.
// 纯逻辑测试跑在 node 环境下（见 vitest.config.ts 的 projects），那里没有 window：
// 不判存在就摸 window 会让 setup 自身抛错，表现为该 project 下每个文件收集失败。
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
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
}
