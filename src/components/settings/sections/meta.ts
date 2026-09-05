/**
 * 设置页「通用」页签下七个分区的元数据——**导航与渲染共用这一份**（规则 #11）。
 *
 * 顺序必须与 GeneralTab 里的渲染顺序一致：搜索时会按这个顺序把全部分区一起渲染，
 * 两边不一致的话用户会看到导航顺序和内容顺序对不上。
 *
 * ❗ label 必须与分区标题（<div className={styles.sSection}>）的文字**逐字一致**：
 * 搜索的 D4 （分区名命中则整节展开）靠的就是那段文字，两边对不上会让「搜分区名」行为不一致。
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
