/** 主题定义 — 6 套配色方案 */

export type ThemeKey = "ocean" | "ocean-dark" | "midnight" | "forest" | "blossom" | "dawn";

export interface Theme {
  key: ThemeKey;
  displayName: string;
  /** 是否为暗色主题 */
  dark: boolean;
}

export const THEMES: Theme[] = [
  { key: "ocean",      displayName: "经典白", dark: false },
  { key: "ocean-dark", displayName: "深海", dark: true },
  { key: "midnight",   displayName: "午夜", dark: true },
  { key: "forest",     displayName: "森林", dark: false },
  { key: "blossom",    displayName: "美乐蒂", dark: false },
  { key: "dawn",       displayName: "晨曦", dark: false },
];

export const DEFAULT_THEME: ThemeKey = "ocean";

/**
 * 把任意配置值归一成合法 ThemeKey。
 *
 * 历史遗留：DEFAULT_CONFIG 里曾经写着 `theme: "light"`，这个值匹配不到任何
 * `[data-theme]` 块，只能落到 `:root` 兜底才碰巧渲染成经典白，设置页色板也因此
 * 一个都不高亮。改掉 DEFAULT_CONFIG 只救得了新装用户 —— 老用户后端存的仍是 "light"，
 * 非空所以照样一路透传下去。所以配置进 store 时先在这里过一道。
 */
export function normalizeTheme(value: unknown): ThemeKey {
  return THEMES.some((t) => t.key === value) ? (value as ThemeKey) : DEFAULT_THEME;
}

/** 清除主题过渡的定时器（模块级：快速连切时只保留最后一次） */
let transitionTimer: ReturnType<typeof setTimeout> | null = null;

/** 将主题应用到 document.documentElement */
export function applyTheme(themeKey: ThemeKey) {
  document.documentElement.setAttribute("data-theme", themeKey);
  // 添加主题切换过渡 — 覆盖更多 CSS 变量相关属性
  document.documentElement.style.transition = "background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease";
  // 延迟清除过渡，确保动画播放完毕后不再影响后续即时切换
  // 防止快速切换主题时旧定时器残留：先清上一次的，再排新的
  if (transitionTimer !== null) clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    document.documentElement.style.transition = "";
    transitionTimer = null;
  }, 350);
}

/** 获取当前主题 */
export function getCurrentTheme(): ThemeKey {
  return (document.documentElement.getAttribute("data-theme") as ThemeKey) || DEFAULT_THEME;
}
