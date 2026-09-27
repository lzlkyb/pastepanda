/**
 * 「记一条」加时间的前端纯函数守卫（快捷条设计稿 §3–§3.5）。
 *
 * ❗ hasAtTail 只是**显隐开关**（预览条要不要出现），解析真值永远在 Rust
 *   `todo_island_parse_due`——这里不许也不需要复刻语法。形状规则必须与 Rust
 *   due_tail 同口径：空白后 @、行尾 1–2 词、剥尾后非空。
 *
 * ❗ 收口不变量（设计稿 §3 ③）：文本 @ 尾巴与快捷条选择**不同时存在**——
 *   提交前 stripAtTail 摘尾巴、打 @ 清快捷条，两端共同钉死这条不变量。
 */
import { describe, expect, it } from "vitest";
import {
  hasAtTail,
  atTailStarted,
  stripAtTail,
  topQuickTimes,
  DEFAULT_QUICK_TIMES,
  QUICK_DATES,
} from "./islandBridge";

describe("hasAtTail（预览条显隐）", () => {
  it("日期 / 日期+时间算尾巴；裸 @ 不算（Rust 无可预览内容）", () => {
    expect(hasAtTail("交报告 @明天")).toBe(true);
    expect(hasAtTail("交报告 @今天 14:00")).toBe(true);
    expect(hasAtTail("买牛奶 @9/26")).toBe(true);
    expect(hasAtTail("交报告 @")).toBe(false);
  });

  it("词中 @（邮箱）不算；三段不算；没 @ 不算；孤立 @ 不算", () => {
    expect(hasAtTail("发到 a@example.com 就行")).toBe(false);
    expect(hasAtTail("交报告 @今天 开完再说")).toBe(true); // 两词尾巴——形状在，解析真值归 Rust
    expect(hasAtTail("交报告 @今天 14:00 开完再说")).toBe(false);
    expect(hasAtTail("交报告")).toBe(false);
    expect(hasAtTail("@今天")).toBe(false); // 剥尾后文字为空 = 不是尾巴（due_tail 同口径）
  });
});

describe("atTailStarted（快捷条清除触发）", () => {
  it("裸 @ / 半个词 / 完整尾巴都算「开始了」——一打 @ 就清快捷条，不等尾巴成形", () => {
    expect(atTailStarted("买牛奶 @")).toBe(true);
    expect(atTailStarted("交报告 @今")).toBe(true);
    expect(atTailStarted("交报告 @今天 14:00")).toBe(true);
  });

  it("词中 @（邮箱）不算；没 @ 不算；行首 @ 不是尾巴（Rust 同口径）", () => {
    expect(atTailStarted("发到 a@example.com")).toBe(false);
    expect(atTailStarted("交报告")).toBe(false);
    expect(atTailStarted("@今天")).toBe(false);
  });
});

describe("stripAtTail（⚠ 纠错 / 快捷条提交共用）", () => {
  it("摘尾巴留正文；正文尾随空格一并收掉", () => {
    expect(stripAtTail("交报告 @今天 14:00")).toBe("交报告");
    expect(stripAtTail("买牛奶 @9/26")).toBe("买牛奶");
    expect(stripAtTail("交报告 @今天 开完再说")).toBe("交报告");
  });

  it("没 @ / 孤立 @ 原样返回", () => {
    expect(stripAtTail("交报告")).toBe("交报告");
    expect(stripAtTail("发到 a@example.com")).toBe("发到 a@example.com");
  });
});

describe("topQuickTimes（时刻 chip 自适应，设计稿 §3.5）", () => {
  it("按次数取 top3；次数高的排前", () => {
    expect(topQuickTimes({ "21:30": 5, "9:00": 2, "12:00": 9, "18:00": 1 })).toEqual([
      "12:00",
      "21:30",
      "9:00",
    ]);
  });

  it("空表 / 不足 3 个 → 默认项补齐（新用户看到 9:00 / 14:00 / 18:00）", () => {
    expect(topQuickTimes({})).toEqual([...DEFAULT_QUICK_TIMES]);
    expect(topQuickTimes({ "21:30": 5 })).toEqual(["21:30", ...DEFAULT_QUICK_TIMES.slice(0, 2)]);
  });

  it("非正计数不算候选；默认项已在候选里不重复补", () => {
    expect(topQuickTimes({ "9:00": 0, "7:30": -1 })).toEqual([...DEFAULT_QUICK_TIMES]);
    expect(topQuickTimes({ "9:00": 3, "14:00": 2, "18:00": 1 })).toEqual([...DEFAULT_QUICK_TIMES]);
  });

  it("时刻档与日期档形状契约：日期是三个相对日、时刻是 HH:MM（拼 @ 尾巴可解析）", () => {
    expect([...QUICK_DATES]).toEqual(["今天", "明天", "后天"]);
    for (const t of topQuickTimes({})) expect(t).toMatch(/^\d{1,2}:\d{2}$/);
  });
});
