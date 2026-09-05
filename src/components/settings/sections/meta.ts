import type { SettingsTabName } from "@/lib/openSettings";

/**
 * 设置页左菜单的元数据——**导航、渲染、scroll-spy 共用这一份**（规则 #11）。
 *
 * 顺序必须与右栏的渲染顺序一致：搜索时会按这个顺序把全部分区一起渲染，
 * 两边不一致的话用户会看到导航顺序和内容顺序对不上。
 *
 * ❗ label 必须与分区标题（<div className={styles.sSection}>）的文字**逐字一致**：
 * 搜索的 D4 （分区名命中则整节展开）靠的就是那段文字，两边对不上会让「搜分区名」行为不一致。
 * scroll-spy 同样靠标题文字反查菜单项。
 */
export const SETTINGS_SECTIONS = [
  { key: "stats",      label: "数据统计",     icon: "📊" },
  { key: "appearance", label: "外观",         icon: "🎨" },
  { key: "general",    label: "通用",         icon: "⚙️" },
  { key: "lan",        label: "局域网同步",   icon: "🌐" },
  { key: "kb",         label: "知识库同步",   icon: "📚" },
  { key: "hotkey",     label: "快捷键",       icon: "⌨️" },
  { key: "data",       label: "数据管理",     icon: "💾" },
] as const;

export type SettingsSectionKey = typeof SETTINGS_SECTIONS[number]["key"];

/**
 * 四个独立页（原顶层 tab）。「通用」拆成了上面七个分区，不再占一项。
 *
 * ❗ 它们原本写在 `SettingsView` 组件里，与上面的 `SETTINGS_SECTIONS` **散成两处**。
 * 而 scroll-spy 与菜单跳转都依赖「数组顺序＝滚动顺序」这个约定，
 * 两处定义迟早会不一致，所以收到这里（规则 #11）。
 *
 * `blossom` 是樱花主题下的替换图标。
 */
export const SETTINGS_PAGES = [
  { key: "ai",    label: "AI",   icon: "✨", blossom: "🌸" },
  // 摆在 AI 后面：两者都是「跟 AI 有关」，但 AI 页管模型/密钥，
  // 本页管的是「让外部 AI 工具读写我的笔记」，方向相反。
  { key: "mcp",   label: "MCP",  icon: "🧩", blossom: "🩷" },
  { key: "help",  label: "帮助", icon: "📖", blossom: "💌" },
  { key: "about", label: "关于", icon: "ℹ",  blossom: "💗" },
] as const;

export type SettingsPageKey = typeof SETTINGS_PAGES[number]["key"];

/** 左菜单的一项：要么是「通用」下的一个分区，要么是四个独立页之一 */
export type SettingsNavKey = SettingsSectionKey | SettingsPageKey;

/**
 * 编译期核对：`SETTINGS_PAGES` 的 key 必须与 `openSettings` 的 tab 名（去掉 general）
 * 完全对应。少一个多一个都在这里报错，而不是等到 `initialTab` 跳转时静默落空。
 */
type _PagesMatchTabs =
  SettingsPageKey extends Exclude<SettingsTabName, "general">
    ? Exclude<SettingsTabName, "general"> extends SettingsPageKey ? true : never
    : never;
const _pagesMatchTabs: _PagesMatchTabs = true;
void _pagesMatchTabs;

export interface SettingsNavEntry {
  key: SettingsNavKey;
  label: string;
  icon: string;
}

/**
 * 菜单全部 11 项（七个分区 + 四个页）。
 * 🔴 **数组顺序即右栏的滚动顺序**，scroll-spy 与点菜单跳转都建在这个约定上。
 */
export function settingsNavItems(blossom: boolean): SettingsNavEntry[] {
  return [
    ...SETTINGS_SECTIONS.map((s): SettingsNavEntry => ({ key: s.key, label: s.label, icon: s.icon })),
    ...SETTINGS_PAGES.map((p): SettingsNavEntry => ({
      key: p.key, label: p.label, icon: blossom ? p.blossom : p.icon,
    })),
  ];
}
