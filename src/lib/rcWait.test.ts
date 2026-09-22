import { describe, it, expect } from "vitest";
import {
  formatWaitSpan,
  waitedMs,
  waitProgress,
  waitRemainingMs,
  WAIT_CONFIRM_MS,
} from "@/lib/rcWait";

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

describe("waitRemainingMs / waitProgress（批3：倒计时）", () => {
  const started = 1_000_000;

  it("窗口与后端对齐为 120s", () => {
    expect(WAIT_CONFIRM_MS).toBe(120_000);
    expect(waitRemainingMs(started, started)).toBe(120_000);
  });

  it("随时间递减，超时后钳在 0（不转负）", () => {
    expect(waitRemainingMs(started, started + 12_000)).toBe(108_000);
    expect(waitRemainingMs(started, started + 120_000)).toBe(0);
    expect(waitRemainingMs(started, started + 200_000)).toBe(0);
  });

  it("起点不可用 → null（不拿 mount 时间编一个）", () => {
    expect(waitRemainingMs(null, started + 1000)).toBeNull();
    expect(waitRemainingMs(undefined, started + 1000)).toBeNull();
    expect(waitRemainingMs(0, started + 1000)).toBeNull();
    expect(waitProgress(null, started + 1000)).toBeNull();
  });

  it("进度线性增长并钳在 0..1", () => {
    expect(waitProgress(started, started)).toBe(0);
    expect(waitProgress(started, started + 60_000)).toBeCloseTo(0.5, 6);
    expect(waitProgress(started, started + 999_999)).toBe(1);
  });
});

describe("formatWaitSpan", () => {
  it("秒 / 分秒 / 整分", () => {
    expect(formatWaitSpan(12_000)).toBe("12 秒");
    expect(formatWaitSpan(108_000)).toBe("1 分 48 秒");
    expect(formatWaitSpan(120_000)).toBe("2 分");
  });

  it("不足 1 秒向上取整成 1 秒（避免「0 秒后自动取消」）", () => {
    expect(formatWaitSpan(99)).toBe("1 秒");
    expect(formatWaitSpan(60_100)).toBe("1 分 1 秒");
    expect(formatWaitSpan(0)).toBe("0 秒");
  });
});
