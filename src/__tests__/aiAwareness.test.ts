/**
 * v6.4 主窗口 AI 感知（引导期 1 周）测试。
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { aiAwarenessActive, AI_AWARENESS_WINDOW_DAYS } from "@/lib/aiAwareness";

const KEY_VER = "pastepanda_ai_aware_ver";
const KEY_AT = "pastepanda_ai_aware_at";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("aiAwarenessActive 引导期窗口", () => {
  it("首次调用（无记录）→ 显示并记录版本", () => {
    const t = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t);
    expect(aiAwarenessActive("5.17.0")).toBe(true);
    expect(localStorage.getItem(KEY_VER)).toBe("5.17.0");
    expect(Number(localStorage.getItem(KEY_AT))).toBe(t);
  });

  it("同版本 7 天内 → 一直显示", () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    aiAwarenessActive("5.17.0");
    // 第 6 天仍显示
    vi.spyOn(Date, "now").mockReturnValue(t0 + 6 * 24 * 3600 * 1000);
    expect(aiAwarenessActive("5.17.0")).toBe(true);
  });

  it("同版本超过 7 天 → 自动隐藏", () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    aiAwarenessActive("5.17.0");
    // 第 8 天隐藏
    vi.spyOn(Date, "now").mockReturnValue(t0 + 8 * 24 * 3600 * 1000);
    expect(aiAwarenessActive("5.17.0")).toBe(false);
  });

  it("版本更新 → 重新开始 1 周", () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    aiAwarenessActive("5.17.0");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 8 * 24 * 3600 * 1000);
    expect(aiAwarenessActive("5.17.0")).toBe(false); // 旧版本已过期
    expect(aiAwarenessActive("5.18.0")).toBe(true); // 新版本重新显示
    expect(localStorage.getItem(KEY_VER)).toBe("5.18.0");
  });

  it("空/未知版本 → 不显示", () => {
    expect(aiAwarenessActive("")).toBe(false);
    expect(aiAwarenessActive("?.?.?")).toBe(false);
  });

  it("窗口常量防漂移", () => {
    expect(AI_AWARENESS_WINDOW_DAYS).toBe(7);
  });
});
