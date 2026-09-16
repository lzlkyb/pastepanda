import { describe, it, expect } from "vitest";
import { waitedMs } from "@/lib/rcWait";

describe("waitedMs (C3)", () => {
  it("null / undefined / 0 → 0", () => {
    expect(waitedMs(null, 1000)).toBe(0);
    expect(waitedMs(undefined, 1000)).toBe(0);
    expect(waitedMs(0, 1000)).toBe(0);
  });

  it("正常已等待", () => {
    expect(waitedMs(1000, 4000)).toBe(3000);
  });

  it("未来（负差）钳到 0", () => {
    expect(waitedMs(5000, 4000)).toBe(0);
  });

  it("中途重新挂载仍从 started_ms 起算（不归零、单调不减）", () => {
    const started = 1000;
    // 首次挂载：等待到 4000
    const first = waitedMs(started, 4000);
    // 组件卸载后重新挂载：now 继续前进，但起点仍是 started，不会归零
    const second = waitedMs(started, 7000);
    expect(first).toBe(3000);
    expect(second).toBe(6000);
    expect(second).toBeGreaterThan(first);
  });
});
