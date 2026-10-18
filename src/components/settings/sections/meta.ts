import type { SettingsTabName } from "@/lib/openSettings";

/** 分组只表达层级，不增加折叠或点击步骤。 */
export const SETTINGS_GROUPS = ["基础设置", "功能设置", "连接与扩展", "数据与支持"] as const;
type SettingsGroup = typeof SETTINGS_GROUPS[number];

/**
 * 导航、搜索、scroll-spy 共用的分类真值；label 与右侧标题逐字一致。
 * 最窄菜单文字预算 70px，名称不超过五个汉字；emoji 保留彩色呈现的 VS16。
 * window 沿用原 key，避免已有编辑器入口因分类改名失效。
 */
export const SETTINGS_SECTIONS = [
  { key: "appearance", label: "外观与窗口", icon: "🎨", group: "基础设置" },
  { key: "hotkey", label: "快捷键", icon: "⌨️", group: "基础设置" },
  { key: "copy", label: "剪贴板", icon: "📋", group: "功能设置" },
  { key: "window", label: "笔记与编辑", icon: "📝", group: "功能设置" },
  { key: "capture", label: "截图与录屏", icon: "📸", group: "功能设置" },
  { key: "island", label: "待办灵动岛", icon: "🏖️", group: "功能设置" },
  { key: "sync", label: "设备与连接", icon: "🌐", group: "连接与扩展" },
  { key: "data", label: "数据管理", icon: "💾", group: "数据与支持" },
  { key: "stats", label: "使用统计", icon: "📊", group: "数据与支持" },
] as const;

export type SettingsSectionKey = typeof SETTINGS_SECTIONS[number]["key"];

/** 旧入口仍定位到小节本身，菜单高亮所属一级分类。 */
export const SETTINGS_SUBSECTIONS: Record<string, { section: SettingsSectionKey; label: string }> = {
  lan: { section: "sync", label: "剪贴板同步" },
  kb: { section: "sync", label: "知识库同步" },
  rc: { section: "sync", label: "远程电脑" },
};

/** 独立配置内容不参与逐行搜索，显示名称与稳定的 tab key 分开。 */
export const SETTINGS_PAGES = [
  { key: "ai", label: "AI 设置", icon: "✨", blossom: "🌸", group: "连接与扩展" },
  { key: "mcp", label: "工具接入", icon: "🧩", blossom: "💖", group: "连接与扩展" },
  { key: "help", label: "帮助", icon: "📖", blossom: "💌", group: "数据与支持" },
  { key: "about", label: "关于", icon: "ℹ️", blossom: "💗", group: "数据与支持" },
] as const;

export type SettingsPageKey = typeof SETTINGS_PAGES[number]["key"];
export type SettingsNavKey = SettingsSectionKey | SettingsPageKey;
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
  group: SettingsGroup;
}

/** 顺序等于实际滚动顺序，包括设备连接与数据管理之间的 AI / 工具接入。 */
export function settingsNavItems(blossom: boolean): SettingsNavEntry[] {
  const items: SettingsNavEntry[] = [
    ...SETTINGS_SECTIONS,
    ...SETTINGS_PAGES.map(p => ({ ...p, icon: blossom ? p.blossom : p.icon })),
  ];
  return SETTINGS_GROUPS.flatMap(group => items.filter(item => item.group === group));
}
