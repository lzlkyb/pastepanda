import { vi } from "vitest";

// 可控制的 mock invoke — 测试中可以 vi.mocked(invoke).mockResolvedValue(...) 来定制返回值
export const invoke = vi.fn().mockResolvedValue(undefined);
