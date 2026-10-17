/**
 * theme.test.ts — 主题工具单元测试
 *
 * 覆盖：
 * - THEMES 常量完整性（6 个主题，每个有 key/displayName/dark）
 * - DEFAULT_THEME 默认值
 * - applyTheme() 一次提交配色、抑制逐元素过渡、处理快速切换与广播回声
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

  it("DEFAULT_THEME 为 ocean", () => {
    expect(DEFAULT_THEME).toBe("ocean");
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    // 清理 document.documentElement 状态
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.transition = "";
    vi.useFakeTimers();
    delete document.documentElement.dataset.themeChanging;
  });

  afterEach(() => {
    vi.advanceTimersByTime(350);
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

  it("30 次连续主题切换只保留一个收尾任务和最后一次选择", () => {
    for (let i = 0; i < 30; i++) applyTheme(THEMES[i % THEMES.length].key);
    expect(getCurrentTheme()).toBe("dawn");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(350);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.documentElement.dataset.themeChanging).toBeUndefined();
  });

  it("350ms 后恢复普通控件的过渡", () => {
    applyTheme("blossom");
    expect(document.documentElement.dataset.themeChanging).toBe("true");

    vi.advanceTimersByTime(350);
    expect(document.documentElement.dataset.themeChanging).toBeUndefined();
  });

  it("快速连续切换主题时旧定时器被清除", () => {
    applyTheme("ocean");
    vi.advanceTimersByTime(200);
    applyTheme("midnight");
    vi.advanceTimersByTime(150);
    expect(document.documentElement.dataset.themeChanging).toBe("true");
    vi.advanceTimersByTime(200);
    expect(document.documentElement.dataset.themeChanging).toBeUndefined();

    // 确认最后一次生效
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
  });

  it("theme swap suppresses descendant transitions during the palette commit", () => {
    applyTheme("forest");
    expect(document.documentElement.dataset.themeChanging).toBe("true");
    expect(document.documentElement.style.transition).toBe("");
  });

  it("same theme echoes do not restart the palette transaction", () => {
    applyTheme("forest");
    vi.advanceTimersByTime(300);
    applyTheme("forest");
    vi.advanceTimersByTime(50);
    expect(document.documentElement.style.transition).toBe("");
    expect(document.documentElement.dataset.themeChanging).toBeUndefined();
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

  it("无 data-theme 属性时返回默认主题 ocean", () => {
    expect(getCurrentTheme()).toBe("ocean");
  });

  it("data-theme 为空字符串时返回默认主题", () => {
    document.documentElement.setAttribute("data-theme", "");
    // 空字符串不是有效的 ThemeKey，会走 fallback
    expect(getCurrentTheme()).toBe("ocean");
  });
});
