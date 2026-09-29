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
 *
 * 🔴 **icon 一律写带 U+FE0F 的 emoji 形式**（`🏖️` 而不是 `🏝`）：全局字体栈
 * （globals.css）里没有 Segoe UI Emoji，Windows 对缺 VS16 的码位走「文本呈现」= 单色字形，
 * 于是彩色图标变黑白（实测：`🏝`/`🗓`/`⏱`/`✂`/`🛡`/`👁`/`ℹ` 裸码位 chroma 0，补 VS16 后 200+）。
 * 少数码位（`🫧` `🛟`）连彩色版都没有，只能换字形。
 */
export const SETTINGS_SECTIONS = [
  { key: "appearance", label: "外观",         icon: "🎨" },
  { key: "copy",       label: "复制与粘贴",   icon: "📋" },
  { key: "window",     label: "窗口与编辑器", icon: "🪟" },
  { key: "hotkey",     label: "快捷键",       icon: "⌨️" },
  { key: "capture",    label: "截图与栈",     icon: "📸" },
  { key: "island",     label: "灵动岛",       icon: "🏖️" },
  { key: "data",       label: "数据管理",     icon: "💾" },
  { key: "sync",       label: "同步与互联",   icon: "🌐" },
  { key: "stats",      label: "数据统计",     icon: "📊" },
] as const;

export type SettingsSectionKey = typeof SETTINGS_SECTIONS[number]["key"];

/**
 * 分区**内**的小节标题 → 它归属哪个菜单项。
 *
 * 小节标题用的是同一个 `sSection` 类（视觉与吸顶行为一致），但**不进左菜单**：
 * 合并分区后的「剪贴板同步 / 知识库同步 / 远程电脑」、截图与栈里的「粘贴栈」、
 * 窗口与编辑器里的「转笔记模板」。
 *
 * 这张表管一件事：外部拿**旧分区 key** 跳进来时（`openSettingsTab("general", "rc")`），
 * 菜单亮所属主节、右栅停在**小节标题**上。没有它的话 `rc` 这个锚点会退回第一节。
 *
 * ❗ scroll-spy 不需要这张表：认不出的标题本来就跳过并保留上一个高亮（见 `useSettingsNav`）。
 *   目前只有 `rc`（App.tsx 的知识库「⋯」）和 `lan`（LanSyncCap 横幅）有调用点，
 *   `kb` 是三个旧 key 里的第三个——留着是因为它对应的小节真实存在，跳进来也该落在墙上。
 */
export const SETTINGS_SUBSECTIONS: Record<string, { section: SettingsSectionKey; label: string }> = {
  lan: { section: "sync", label: "剪贴板同步" },
  kb: { section: "sync", label: "知识库同步" },
  rc: { section: "sync", label: "远程电脑" },
};

/**
 * 四个独立页（原顶层 tab）。「通用」这个兜底分区在 2026-09 的分区重排里被拆掉了，
 * 不再占一项。
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
  { key: "mcp",   label: "MCP",  icon: "🧩", blossom: "💖" },
  { key: "help",  label: "帮助", icon: "📖", blossom: "💌" },
  { key: "about", label: "关于", icon: "ℹ️",  blossom: "💗" },
] as const;

export type SettingsPageKey = typeof SETTINGS_PAGES[number]["key"];

/** 左菜单的一项：要么是九个分区之一，要么是四个独立页之一 */
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
 * 菜单全部 13 项（九个分区 + 四个页）。
 * 🔴 **数组顺序即右栏的滚动顺序**，scroll-spy 与点菜单跳转都建在这个约定上。
 * 条目数别在注释里当真理看——分区变了要回来对一眼（真正的双向一致性由
 * `settingsNavLabels.test.ts` 与渲染顺序钉）。
 */
export function settingsNavItems(blossom: boolean): SettingsNavEntry[] {
  return [
    ...SETTINGS_SECTIONS.map((s): SettingsNavEntry => ({ key: s.key, label: s.label, icon: s.icon })),
    ...SETTINGS_PAGES.map((p): SettingsNavEntry => ({
      key: p.key, label: p.label, icon: blossom ? p.blossom : p.icon,
    })),
  ];
}
