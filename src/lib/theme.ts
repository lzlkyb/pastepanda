/** 主题定义 — 6 套配色方案 */

export type ThemeKey = "ocean" | "ocean-dark" | "midnight" | "forest" | "blossom" | "dawn";

export interface Theme {
  key: ThemeKey;
  displayName: string;
  /** 是否为暗色主题 */
  dark: boolean;
}

export const THEMES: Theme[] = [
  // key 是后端存储值 + theme.css 的 [data-theme] 锚点，改名只改 displayName。
  { key: "ocean",      displayName: "月白", dark: false },
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
 * `[data-theme]` 块，只能落到 `:root` 兜底才碰巧渲染成月白，设置页色板也因此
 * 一个都不高亮。改掉 DEFAULT_CONFIG 只救得了新装用户 —— 老用户后端存的仍是 "light"，
 * 非空所以照样一路透传下去。所以配置进 store 时先在这里过一道。
 */
export function normalizeTheme(value: unknown): ThemeKey {
  return THEMES.some((t) => t.key === value) ? (value as ThemeKey) : DEFAULT_THEME;
}

/**
 * 主题是否为暗色（内部先归一，未知值落 DEFAULT_THEME 的档）。
 *
 * 服务于「不跟 `[data-theme]` 全套变量、只要亮暗二档」的宿主：灵动岛
 * （html[data-island-mode] 两套材质）、全屏编辑器外壳、笔记第三栏编辑区。
 * 收口记录：FullscreenShell / FullscreenEditor / useNoteEditorState 原各有一份
 * `THEMES.find(...)?.dark ?? false`，第 4 个调用点（灵动岛）出现时收到这里（规则 11.1）。
 */
export function isDarkTheme(value: unknown): boolean {
  return THEMES.find((t) => t.key === normalizeTheme(value))?.dark ?? false;
}

/** 配色提交窗口；快速连切与跨窗口回声共用一个生命周期。 */
let transitionTimer: ReturnType<typeof setTimeout> | null = null;

/** 将主题应用到 document.documentElement */
export function applyTheme(themeKey: ThemeKey) {
  const root = document.documentElement;
  if (root.getAttribute("data-theme") === themeKey) return;
  // A palette change touches the whole tree. Do not start one color/background
  // transition per descendant; the native trace showed repeated style work here.
  root.dataset.themeChanging = "true";
  root.setAttribute("data-theme", themeKey);
  if (transitionTimer !== null) clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    delete root.dataset.themeChanging;
    transitionTimer = null;
  }, 350);
}

/** 获取当前主题 */
export function getCurrentTheme(): ThemeKey {
  return (document.documentElement.getAttribute("data-theme") as ThemeKey) || DEFAULT_THEME;
}
