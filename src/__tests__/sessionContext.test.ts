import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  pushToSession,
  getSession,
  resetSession,
  isUniformType,
  mergeSessionTexts,
  __resetSessionForTest,
} from "@/lib/sessionContext";

describe("sessionContext · 工作记忆会话桶", () => {
  beforeEach(() => {
    __resetSessionForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T10:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetSessionForTest();
  });

  it("90s 内连续复制聚成一个会话", () => {
    pushToSession("代码 A", "code");
    vi.advanceTimersByTime(30_000);
    pushToSession("代码 B", "code");
    vi.advanceTimersByTime(30_000);
    pushToSession("代码 C", "code");

    const s = getSession();
    expect(s).not.toBeNull();
    expect(s!.texts).toEqual(["代码 A", "代码 B", "代码 C"]);
  });

  it("超过 90s 间隔 → 新会话（旧桶丢弃）", () => {
    pushToSession("段落一", "text");
    vi.advanceTimersByTime(120_000);
    pushToSession("新任务段落", "text");

    const s = getSession();
    expect(s!.texts).toEqual(["新任务段落"]);
  });

  it("超过 8 条开新桶", () => {
    for (let i = 0; i < 9; i++) {
      pushToSession(`条目 ${i}`, "text");
      vi.advanceTimersByTime(10_000);
    }
    const s = getSession();
    expect(s!.texts.length).toBeLessThanOrEqual(8);
    // 第 9 条触发新桶，桶里应是最后几条
    expect(s!.texts).toContain("条目 8");
  });

  it("同内容连贴不累计（去重）", () => {
    pushToSession("同一段", "text");
    pushToSession("同一段", "text");
    const s = getSession();
    expect(s!.texts.length).toBe(1);
  });

  it("同内容连贴是去重而**不是重置**：已攒的条目不能丢", () => {
    // 回归：旧实现把“末条与新内容相同”写进了 isNew 的 OR，命中时会**新建桶**，
    // 于是 A,B,B,C 只剩 [B,C]——A 静默丢失。上面那条只断言 length===1，
    // 两种行为都满足，抓不到这个 bug。
    pushToSession("A", "code");
    pushToSession("B", "code");
    pushToSession("B", "code"); // 重复：应被忽略，不开新桶
    pushToSession("C", "code");
    const s = getSession();
    expect(s!.texts).toEqual(["A", "B", "C"]);
  });

  it("超过会话间隔后重复同一内容，仍开新会话", () => {
    pushToSession("同一段", "text");
    vi.advanceTimersByTime(100_000); // > GAP_MS
    pushToSession("同一段", "text");
    const s = getSession();
    expect(s!.texts).toEqual(["同一段"]);
    expect(s!.texts.length).toBe(1);
  });

  it("过期会话 getSession 返回 null", () => {
    pushToSession("旧内容", "text");
    vi.advanceTimersByTime(100_000);
    expect(getSession()).toBeNull();
  });

  it("isUniformType：全同类为 true，混类为 false", () => {
    pushToSession("a", "code");
    pushToSession("b", "code");
    expect(isUniformType(getSession()!, "code")).toBe(true);

    __resetSessionForTest();
    pushToSession("a", "code");
    pushToSession("b", "text");
    expect(isUniformType(getSession()!, "code")).toBe(false);
  });

  it("mergeSessionTexts 用 --- 分隔拼接", () => {
    pushToSession("第一段", "text");
    pushToSession("第二段", "text");
    const merged = mergeSessionTexts(getSession()!);
    expect(merged).toContain("第一段");
    expect(merged).toContain("第二段");
    expect(merged).toContain("---");
  });

  it("resetSession 清空", () => {
    pushToSession("x", "text");
    resetSession();
    expect(getSession()).toBeNull();
  });
});
