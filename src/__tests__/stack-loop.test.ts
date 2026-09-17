import { describe, it, expect } from "vitest";
import { loopProgress } from "@/lib/stack/loop";

/**
 * `loopProgress` 是「本轮还剩几条」的**唯一实现**（横幅脚注与 `stackPasteNext`
 * 的 toast / 浮标都调它）。它错了的表现是「横幅说还剩 2 条、浮标说还剩 3 条」，
 * 而这种不一致在真机上很难一眼看出来，所以在这里钉死。
 */
const items = (...ids: string[]) => ids.map((id) => ({ id }));

describe("loopProgress", () => {
  it("空队列 → 全 0", () => {
    expect(loopProgress([], new Set())).toEqual({ done: 0, total: 0, remaining: 0 });
  });

  it("无任何已贴 → 全部算作本轮剩余", () => {
    expect(loopProgress(items("a", "b", "c"), new Set())).toEqual({
      done: 0,
      total: 3,
      remaining: 3,
    });
  });

  it("循环态部分已贴 → 按队列里实际存在的计", () => {
    // 贴了 a 之后队列轮转成 [b, c, a]
    expect(loopProgress(items("b", "c", "a"), new Set(["a"]))).toEqual({
      done: 1,
      total: 3,
      remaining: 2,
    });
  });

  it("doneIds 里的**死 id**（条目已被 ✕ 删除）不参与计数", () => {
    // a 已被删除，但它留在 doneIds 里 —— 若按 doneIds.size 算会得到 done=2，多算一条
    expect(loopProgress(items("b", "c"), new Set(["a", "b"]))).toEqual({
      done: 1,
      total: 2,
      remaining: 1,
    });
  });

  it("非循环态（已贴条目已出栈）→ 退化成「剩余 = 队列长度」", () => {
    // 非循环态下 doneIds 里的 id 都不在队列里，于是 done 恒为 0
    expect(loopProgress(items("c"), new Set(["a", "b"]))).toEqual({
      done: 0,
      total: 1,
      remaining: 1,
    });
  });
});
