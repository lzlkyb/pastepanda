/**
 * theme.test.ts — 主题工具单元测试
 *
 * 覆盖：
 * - THEMES 常量完整性（6 个主题，每个有 key/displayName/dark）
 * - DEFAULT_THEME 默认值
 * - applyTheme() 设置 data-theme 属性 + 过渡样式 + 定时器清理
 * - getCurrentTheme() 读取当前主题
 * - 边界：无 data-theme 属性时返回默认值
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  THEMES,
  DEFAULT_THEME,
  applyTheme,
  getCurrentTheme,
} from "@/lib/theme";

describe("THEMES 常量", () => {
  it("包含 6 个主题", () => {
    expect(THEMES).toHaveLength(6);
  });

  it("每个主题都有 key, displayName, dark 字段", () => {
    for (const theme of THEMES) {
      expect(theme).toHaveProperty("key");
      expect(theme).toHaveProperty("displayName");
      expect(theme).toHaveProperty("dark");
      expect(typeof theme.key).toBe("string");
      expect(typeof theme.displayName).toBe("string");
      expect(typeof theme.dark).toBe("boolean");
    }
  });

  it("所有主题 key 唯一", () => {
    const keys = THEMES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("包含预期主题", () => {
    const keys = THEMES.map((t) => t.key).sort();
    expect(keys).toEqual([
      "blossom",
      "dawn",
      "forest",
      "midnight",
      "ocean",
      "ocean-dark",
    ]);
  });

  it("暗色主题有 midnight, ocean-dark", () => {
    const darkKeys = THEMES.filter((t) => t.dark).map((t) => t.key).sort();
    expect(darkKeys).toEqual(["midnight", "ocean-dark"]);
  });

  it("亮色主题有 ocean, forest, blossom, dawn", () => {
    const lightKeys = THEMES.filter((t) => !t.dark).map((t) => t.key).sort();
    expect(lightKeys).toEqual(["blossom", "dawn", "forest", "ocean"]);
  });

  it("DEFAULT_THEME 为 ocean-dark", () => {
    expect(DEFAULT_THEME).toBe("ocean-dark");
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    // 清理 document.documentElement 状态
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.transition = "";
    // 清理 applyTheme 上的定时器引用
    (applyTheme as any)._clearTimer?.();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("设置 data-theme 属性到 documentElement", () => {
    applyTheme("midnight");
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
  });

  it("切换不同主题会更新 data-theme 属性", () => {
    applyTheme("ocean");
    expect(document.documentElement.getAttribute("data-theme")).toBe("ocean");

    applyTheme("dawn");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dawn");
  });

  it("应用主题时设置过渡样式", () => {
    applyTheme("forest");
    expect(document.documentElement.style.transition).toContain("background-color");
    expect(document.documentElement.style.transition).toContain("color");
    expect(document.documentElement.style.transition).toContain("border-color");
    expect(document.documentElement.style.transition).toContain("box-shadow");
  });

  it("350ms 后清除过渡样式", () => {
    applyTheme("blossom");
    expect(document.documentElement.style.transition).not.toBe("");

    vi.advanceTimersByTime(350);
    expect(document.documentElement.style.transition).toBe("");
  });

  it("快速连续切换主题时旧定时器被清除", () => {
    applyTheme("ocean");
    applyTheme("midnight");

    // 350ms 后只有一次清除
    vi.advanceTimersByTime(350);
    expect(document.documentElement.style.transition).toBe("");

    // 确认最后一次生效
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
  });
});

describe("getCurrentTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("返回当前 data-theme 属性值", () => {
    document.documentElement.setAttribute("data-theme", "dawn");
    expect(getCurrentTheme()).toBe("dawn");
  });

  it("无 data-theme 属性时返回默认主题 ocean-dark", () => {
    expect(getCurrentTheme()).toBe("ocean-dark");
  });

  it("data-theme 为空字符串时返回默认主题", () => {
    document.documentElement.setAttribute("data-theme", "");
    // 空字符串不是有效的 ThemeKey，会走 fallback
    expect(getCurrentTheme()).toBe("ocean-dark");
  });
});
