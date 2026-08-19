#!/usr/bin/env node
/**
 * gen-changelog.mjs
 *
 * Parses CHANGELOG.md and generates src/lib/changelog.generated.ts
 *
 * Usage:  node scripts/gen-changelog.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Paths ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGELOG_PATH = resolve(ROOT, "CHANGELOG.md");
const OUTPUT_PATH = resolve(ROOT, "src", "lib", "changelog.generated.ts");

// ─── Category mapping ──────────────────────────────────

/**
 * Map an H3 header text to { type, displayName }.
 * The display name strips parenthetical suffixes.
 */
function mapCategory(headerText) {
  const trimmed = headerText.trim();

  // Extract display name: strip trailing parenthetical / bracket groups
  // e.g. "UI/UX 体验专项（58 项全部修复，详见 docs/...）" → "UI/UX 体验专项"
  // e.g. "安全（代码审计专项，详见 docs/...）" → "安全"
  // e.g. "其他修复（Low）" → "其他修复"
  let displayName = trimmed
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();

  // Exact matches first
  const exactMap = {
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

  // Prefix / pattern matches
  if (/^UI\/UX/i.test(displayName) || /^UI\/UX/i.test(trimmed)) {
    return { type: "uiux", name: displayName };
  }
  if (/^其他修复/.test(displayName) || /^其他修复/.test(trimmed)) {
    return { type: "other", name: displayName };
  }

  // Fallback
  return { type: "other", name: displayName };
}

// ─── Parser ────────────────────────────────────────────

/**
 * Parse CHANGELOG.md into an array of entry objects.
 */
function parseChangelog(markdown) {
  const lines = markdown.split(/\r?\n/);
  const entries = [];

  let currentEntry = null;   // { version, date, categories: [], _currentCat, _currentGroup }
  let lastItem = null;       // 最近一条 bullet 条目，用于挂载缩进子项（用法/配图）

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── H2: version header ──
    const h2Match = line.match(/^##\s+\[(\d+\.\d+\.\d+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/);
    if (h2Match) {
      // Finalize previous entry
      if (currentEntry) {
        finalizeCat(currentEntry);
        finalizeEntry(currentEntry);
        entries.push(currentEntry);
      }
      currentEntry = {
        version: h2Match[1],
        date: h2Match[2] || "",
        categories: [],
        _currentCat: null,
        _currentGroup: null,
      };
      lastItem = null;
      continue;
    }

    if (!currentEntry) continue; // Skip preamble before first entry

    // ── H3: category header ──
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      // Finalize previous category
      finalizeCat(currentEntry);

      const { type, name } = mapCategory(h3Match[1]);
      currentEntry._currentCat = {
        type,
        name,
        items: [],
        groups: [],
      };
      currentEntry._currentGroup = null;
      lastItem = null;
      continue;
    }

    if (!currentEntry._currentCat) continue; // Skip lines before any category

    // ── Sub-group header: **Bold text** ──
    const subMatch = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (subMatch) {
      // Any items collected before this sub-group header become plain items
      // Start a new group
      currentEntry._currentGroup = {
        label: subMatch[1],
        items: [],
      };
      currentEntry._currentCat.groups.push(currentEntry._currentGroup);
      lastItem = null;
      continue;
    }

    // ── Bullet item ──
    const bulletMatch = line.match(/^-\s+(.+)/);
    if (bulletMatch) {
      const item = { text: bulletMatch[1] };
      if (currentEntry._currentGroup) {
        currentEntry._currentGroup.items.push(item);
      } else {
        currentEntry._currentCat.items.push(item);
      }
      lastItem = item;
      continue;
    }

    // ── 缩进子项：为什么 / 用法 / 配图（挂载到上一条 bullet 条目，用于发版弹框功能卡片） ──
    const subField = line.match(/^[ \t]{2,}(为什么|有什么用|用法|配图)\s*[:：]\s*(.+)$/);
    if (subField && lastItem) {
      const key = subField[1];
      const val = subField[2].trim();
      if (key === "配图") {
        lastItem.media = val;
      } else if (key === "用法") {
        // 用法：按 ； ; → / 拆成步骤
        lastItem.how = val
          .split(/[；;→/]/)
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        // 为什么 / 有什么用：一句话价值说明（卡片「有什么用」行）
        lastItem.why = val;
      }
      continue;
    }

    // ── Continuation line (indented or non-blank text following a bullet) ──
    const contMatch = line.match(/^\s{2,}(.+)/);
    if (contMatch && line.trim().length > 0) {
      // Append to the last item in the current group or category
      const target = currentEntry._currentGroup
        ? currentEntry._currentGroup.items
        : currentEntry._currentCat.items;
      if (target.length > 0) {
        target[target.length - 1].text += " " + contMatch[1].trim();
      }
    }
  }

  // Finalize last entry
  if (currentEntry) {
    finalizeCat(currentEntry);
    finalizeEntry(currentEntry);
    entries.push(currentEntry);
  }

  return entries;
}

/** Finalize the current category on an entry — move it into categories array */
function finalizeCat(entry) {
  if (!entry._currentCat) return;

  const cat = entry._currentCat;
  // Remove empty arrays to keep output clean
  if (cat.items.length === 0) delete cat.items;
  if (cat.groups.length === 0) {
    delete cat.groups;
  } else {
    // If there are groups, remove empty items array
    delete cat.items;
    // Remove groups with no items
    cat.groups = cat.groups.filter(g => g.items.length > 0);
    if (cat.groups.length === 0) delete cat.groups;
  }

  // Only add category if it has content
  if (cat.items || cat.groups) {
    entry.categories.push(cat);
  }
  entry._currentCat = null;
  entry._currentGroup = null;
}

/** Finalize an entry — generate summary, clean up temp fields */
function finalizeEntry(entry) {
  delete entry._currentCat;
  delete entry._currentGroup;

  // Generate summary from first category's first items
  entry.summary = generateSummary(entry);
}

/** Generate a one-line summary (≤40 chars) from the entry */
function generateSummary(entry) {
  if (entry.categories.length === 0) return "";

  // Collect first few item texts from the first category
  const firstCat = entry.categories[0];
  const texts = [];
  if (firstCat.items) {
    for (const item of firstCat.items) {
      texts.push(item.text);
    }
  } else if (firstCat.groups) {
    for (const group of firstCat.groups) {
      for (const item of group.items) {
        texts.push(item.text);
      }
    }
  }

  if (texts.length === 0) return entry.categories[0].name || "";

  // Strategy: use first item text, truncated to 40 chars
  const first = texts[0];
  if (first.length <= 40) return first;
  return first.slice(0, 37) + "...";
}

// ─── Code generation ───────────────────────────────────

/** Escape a string for embedding in TypeScript source (double-quoted) */
function escapeStr(str) {
  // Use JSON.stringify which handles all escaping correctly,
  // then we already have the surrounding double quotes
  return JSON.stringify(str);
}

/** 序列化一条 ChangeItem 的全部字段（text 必填，why/how/media 可选） */
function itemFields(item) {
  const parts = [` text: ${escapeStr(item.text)}`];
  if (item.why) parts.push(` why: ${escapeStr(item.why)}`);
  if (item.how && item.how.length > 0) {
    const arr = item.how.map((s) => escapeStr(s)).join(", ");
    parts.push(` how: [${arr}]`);
  }
  if (item.media) parts.push(` media: ${escapeStr(item.media)}`);
  return parts.join(",");
}

/** Indent helper */
function indent(level) {
  return "  ".repeat(level);
}

/** Generate the TypeScript output */
function generateTS(entries) {
  const lines = [];
  lines.push("// AUTO-GENERATED by scripts/gen-changelog.mjs — DO NOT EDIT");
  lines.push('import type { ChangelogEntry } from "./changelog";');
  lines.push("");
  lines.push("export const CHANGELOG: ChangelogEntry[] = [");

  for (const entry of entries) {
    lines.push(`${indent(1)}{`);
    lines.push(`${indent(2)}version: ${escapeStr(entry.version)},`);
    lines.push(`${indent(2)}date: ${escapeStr(entry.date)},`);
    lines.push(`${indent(2)}summary: ${escapeStr(entry.summary)},`);
    lines.push(`${indent(2)}categories: [`);

    for (const cat of entry.categories) {
      lines.push(`${indent(3)}{`);
      lines.push(`${indent(4)}type: ${escapeStr(cat.type)},`);
      lines.push(`${indent(4)}name: ${escapeStr(cat.name)},`);

      if (cat.items && cat.items.length > 0) {
        lines.push(`${indent(4)}items: [`);
        for (const item of cat.items) {
          lines.push(`${indent(5)}{${itemFields(item)}},`);
        }
        lines.push(`${indent(4)}],`);
      }

      if (cat.groups && cat.groups.length > 0) {
        lines.push(`${indent(4)}groups: [`);
        for (const group of cat.groups) {
          lines.push(`${indent(5)}{`);
          lines.push(`${indent(6)}label: ${escapeStr(group.label)},`);
          lines.push(`${indent(6)}items: [`);
          for (const item of group.items) {
            lines.push(`${indent(7)}{${itemFields(item)}},`);
          }
          lines.push(`${indent(6)}],`);
          lines.push(`${indent(5)}},`);
        }
        lines.push(`${indent(4)}],`);
      }

      lines.push(`${indent(3)}},`);
    }

    lines.push(`${indent(2)}],`);
    lines.push(`${indent(1)}},`);
  }

  lines.push("];");
  lines.push("");

  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────

function main() {
  let markdown;
  try {
    markdown = readFileSync(CHANGELOG_PATH, "utf-8");
  } catch (err) {
    console.error(`Error reading CHANGELOG.md: ${err.message}`);
    process.exit(1);
  }

  const entries = parseChangelog(markdown);

  if (entries.length === 0) {
    console.warn("Warning: No changelog entries found in CHANGELOG.md");
  }

  const output = generateTS(entries);

  try {
    writeFileSync(OUTPUT_PATH, output, "utf-8");
    console.log(`Generated ${OUTPUT_PATH}`);
    console.log(`  ${entries.length} version(s) parsed`);
    for (const e of entries) {
      const catCount = e.categories.length;
      console.log(`  - v${e.version} (${e.date || "no date"}): ${catCount} categor${catCount === 1 ? "y" : "ies"}`);
    }
  } catch (err) {
    console.error(`Error writing output: ${err.message}`);
    process.exit(1);
  }
}

main();
