/**
 * changelogParser.ts — 运行时更新日志解析器
 *
 * 将 Markdown 版本段落解析为 ChangelogEntry 结构化数据。
 *
 * 存在原因：更新弹框（UpdateNotesDialog）展示的是"目标版本"的更新日志，
 * 而目标版本必然新于当前二进制 —— 构建时打包的 changelog.generated.ts
 * 只含构建时已发布的版本，查找必然落空。因此需要实时解析更新清单的
 * notes（update.body，CI 从同一份 CHANGELOG.md 提取，见
 * scripts/extract-release-notes.mjs）。
 *
 * 解析规则与 scripts/gen-changelog.mjs 保持严格一致（分类映射、分组、
 * 续行合并、摘要生成），确保构建时产物与运行时解析渲染结果相同。
 *
 * 兼容两种输入：
 *   1. 带 "### 分类" 标题的完整段落（v5.3.3 起的 updater notes）→ 还原分类 chips
 *   2. 纯 "- " 平铺列表（v5.3.2 及更早的 notes 格式，分类标题被剥离）
 *      → 全部条目归入单个「更新内容」分类
 */

import type {
  ChangeCategory,
  ChangeCategoryType,
  ChangeGroup,
  ChangeItem,
  ChangelogEntry,
} from "./changelog";

// ─── 分类映射（与 gen-changelog.mjs 一致） ─────────────

/** 将 H3 分类标题映射为 { type, name }（name 去掉括号后缀） */
function mapCategory(headerText: string): { type: ChangeCategoryType; name: string } {
  const trimmed = headerText.trim();

  // 显示名：去掉尾部括号注释，如 "UI/UX 体验专项（58 项）" → "UI/UX 体验专项"
  const displayName = trimmed.replace(/[（(][^）)]*[）)]/g, "").trim();

  const exactMap: Record<string, ChangeCategoryType> = {
    "新增": "feat",
    "新功能": "feat",
    "修复": "fix",
    "变更": "change",
    "安全": "security",
    "性能": "perf",
    "技术": "tech",
    "崩溃与数据完整性": "stability",
    "重构": "tech",
  };

  if (exactMap[displayName]) {
    return { type: exactMap[displayName], name: displayName };
  }
  if (/^UI\/UX/i.test(displayName) || /^UI\/UX/i.test(trimmed)) {
    return { type: "uiux", name: displayName };
  }
  if (/^其他修复/.test(displayName) || /^其他修复/.test(trimmed)) {
    return { type: "other", name: displayName };
  }
  // 兜底（"改进"等未显式映射的分类与构建时一致归入 other）
  return { type: "other", name: displayName };
}

// ─── 内部解析状态 ──────────────────────────────────────

interface CatAccum {
  type: ChangeCategoryType;
  name: string;
  items: ChangeItem[];
  groups: ChangeGroup[];
}

/** 纯 bullet 平铺输入（分类标题被 CI 剥离的旧格式 notes）的默认分类 */
const FLAT_CATEGORY_NAME = "更新内容";

// ─── 解析器 ────────────────────────────────────────────

/**
 * 解析单个版本的更新日志段落。
 *
 * @param markdown 版本段落原文。可含或不含 H2 版本头（## [x.y.z] - date）、
 *                 H3 分类标题、**加粗** 分组标签、"- " 条目与缩进续行。
 * @param version  目标版本号（作为返回条目的 version）。
 * @returns 解析出的条目；markdown 为空或无任何可识别条目时返回 null。
 */
export function parseChangelogSection(markdown: string | null | undefined, version: string): ChangelogEntry | null {
  if (!markdown || !markdown.trim()) return null;

  const lines = markdown.split(/\r?\n/);
  const categories: ChangeCategory[] = [];
  let currentCat: CatAccum | null = null;
  let currentGroup: ChangeGroup | null = null;
  let date = "";
  let lastItem: ChangeItem | null = null; // 最近一条 bullet，用于挂载缩进子项（用法/配图）

  /** 收口当前分类：剔除空数组后压入 categories */
  const finalizeCat = () => {
    if (!currentCat) return;
    const cat: ChangeCategory = { type: currentCat.type, name: currentCat.name };
    if (currentCat.groups.length > 0) {
      const groups = currentCat.groups.filter((g) => g.items.length > 0);
      if (groups.length > 0) cat.groups = groups;
    }
    if (currentCat.items.length > 0) cat.items = currentCat.items;
    if (cat.items || cat.groups) categories.push(cat);
    currentCat = null;
    currentGroup = null;
  };

  for (const line of lines) {
    // ── H2 版本头（可选）：仅提取日期 ──
    const h2Match = line.match(/^##\s+\[(\d+\.\d+\.\d+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/);
    if (h2Match) {
      if (h2Match[2]) date = h2Match[2];
      continue;
    }

    // ── H3 分类标题 ──
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      finalizeCat();
      const { type, name } = mapCategory(h3Match[1]);
      currentCat = { type, name, items: [], groups: [] };
      currentGroup = null;
      lastItem = null;
      continue;
    }

    // ── **加粗** 分组标签行 ──
    const subMatch = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (subMatch) {
      // 平铺输入不会出现分组行；此处仅对结构化输入生效
      if (!currentCat) {
        currentCat = { type: "other", name: FLAT_CATEGORY_NAME, items: [], groups: [] };
      }
      currentGroup = { label: subMatch[1], items: [] };
      currentCat.groups.push(currentGroup);
      lastItem = null;
      continue;
    }

    // ── bullet 条目 ──
    const bulletMatch = line.match(/^-\s+(.+)/);
    if (bulletMatch) {
      // 分类标题缺失（旧格式平铺 notes）时惰性创建默认分类，避免丢条目
      if (!currentCat) {
        currentCat = { type: "other", name: FLAT_CATEGORY_NAME, items: [], groups: [] };
        currentGroup = null;
      }
      const item: ChangeItem = { text: bulletMatch[1] };
      if (currentGroup) {
        currentGroup.items.push(item);
      } else {
        currentCat.items.push(item);
      }
      lastItem = item;
      continue;
    }

    // ── 缩进子项：用法 / 配图（挂载到上一条 bullet，与 gen-changelog.mjs 一致） ──
    const subField = line.match(/^[ \t]{2,}(用法|配图)\s*[:：]\s*(.+)$/);
    if (subField && lastItem) {
      const key = subField[1];
      const val = subField[2].trim();
      if (key === "配图") {
        lastItem.media = val;
      } else {
        lastItem.how = val
          .split(/[；;→/]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      continue;
    }

    // ── 续行（缩进 ≥2 格的非空文本）：并入上一条目 ──
    const contMatch = line.match(/^\s{2,}(.+)/);
    if (contMatch && line.trim().length > 0 && currentCat) {
      const target = currentGroup ? currentGroup.items : currentCat.items;
      if (target.length > 0) {
        target[target.length - 1].text += " " + contMatch[1].trim();
      }
    }
  }

  finalizeCat();

  if (categories.length === 0) return null;

  return {
    version,
    date,
    summary: generateSummary(categories),
    categories,
  };
}

// ─── 摘要生成（与 gen-changelog.mjs 一致） ─────────────

/** 取首个分类的首条条目、截断至 40 字符，作为摘要引语 */
function generateSummary(categories: ChangeCategory[]): string {
  if (categories.length === 0) return "";

  const firstCat = categories[0];
  const texts: string[] = [];
  if (firstCat.items) {
    for (const item of firstCat.items) texts.push(item.text);
  } else if (firstCat.groups) {
    for (const group of firstCat.groups) {
      for (const item of group.items) texts.push(item.text);
    }
  }

  if (texts.length === 0) return firstCat.name || "";

  const first = texts[0];
  if (first.length <= 40) return first;
  return first.slice(0, 37) + "...";
}
