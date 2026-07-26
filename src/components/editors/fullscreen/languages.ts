/**
 * 代码全屏编辑器 — 语言工具。
 *
 * 语言信息来源：分类引擎把语言子标签（"Rust"、"YAML" 等）写入自动标签，
 * 调用方（TextEditor 的全屏按钮）经 findLanguageTag 从 item.tags 派生，
 * 经 open_fullscreen_editor 的 language 参数传入，编辑器内动态加载 CodeMirror 语言模式。
 *
 * 动态加载：@codemirror/language-data 的 LanguageDescription.load() 为懒加载 import，
 * 按需引入对应 @codemirror/lang-* 包，不影响编辑器首屏。
 */
import { languages } from "@codemirror/language-data";
import type { LanguageSupport } from "@codemirror/language";

/** 分类器可能产生的语言/格式子标签（与 ensure_auto_tags 种子名一致） */
const CODE_LANG_TAGS = new Set([
  "Python", "JavaScript", "TypeScript", "Rust", "Java",
  "Go", "SQL", "HTML", "CSS", "Shell",
  "YAML", "TOML", "ENV", "INI",
]);

/** 从条目的自动标签中派生语言子标签（无则 null） */
export function findLanguageTag(tags?: { name: string; source: string }[]): string | null {
  if (!tags) return null;
  const hit = tags.find((t) => t.source === "auto" && CODE_LANG_TAGS.has(t.name));
  return hit ? hit.name : null;
}

/** 显示名 → language-data 语言名（ENV/INI 无同名条目，需映射；其余同名） */
function toLanguageDataName(displayName: string): string {
  if (displayName === "ENV") return "Properties files";
  if (displayName === "INI") return "TOML";
  return displayName;
}

/** 语言品牌色（与 ensure_auto_tags 种子颜色一致，未收录的走 text-muted） */
export const LANG_COLORS: Record<string, string> = {
  Python: "#3776AB", JavaScript: "#F7DF1E", TypeScript: "#3178C6", Rust: "#DEA584",
  Java: "#ED8B00", Go: "#00ADD8", SQL: "#4479A1", HTML: "#E34F26", CSS: "#1572B6",
  Shell: "#4EAA25",
  YAML: "#CB171E", TOML: "#9C4221", ENV: "#ECD53F", INI: "#7C8DA5",
};

/** 选择器精选：常用语言（后端可识别的 10 种） */
export const COMMON_CODE_LANGS = [
  "Rust", "JavaScript", "TypeScript", "Python", "Go",
  "Java", "SQL", "HTML", "CSS", "Shell",
];

/** 选择器精选：配置文件格式 */
export const COMMON_CONFIG_FMTS = ["YAML", "TOML", "ENV", "INI"];

const supportCache = new Map<string, Promise<LanguageSupport | null>>();

/** 按显示名加载 CodeMirror 语言模式（懒加载 + 缓存）；查无此语言返回 null */
export function loadLanguageSupport(displayName: string): Promise<LanguageSupport | null> {
  const key = toLanguageDataName(displayName);
  let p = supportCache.get(key);
  if (!p) {
    const desc = languages.find((l) => l.name === key);
    p = desc ? desc.load() : Promise.resolve(null);
    supportCache.set(key, p);
  }
  return p;
}

/** 扩展名特例（映射语言的主扩展名不符合习惯时用此表） */
const EXT_OVERRIDES: Record<string, string> = { ENV: "env", INI: "ini" };

/** 语言 → 建议文件扩展名（取 language-data 首个扩展名；查无返回 null） */
export function languageFileExtension(displayName: string): string | null {
  if (EXT_OVERRIDES[displayName]) return EXT_OVERRIDES[displayName];
  const desc = languages.find((l) => l.name === toLanguageDataName(displayName));
  return desc?.extensions?.[0] ?? null;
}
