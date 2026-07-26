import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { CHANGELOG } from "@/lib/changelog.generated";
import {
  CATEGORY_COLORS,
  countEntryItems,
  compareVersions,
  type ChangeCategoryType,
  type ChangeCategory,
  type ChangelogEntry,
} from "@/lib/changelog";
import styles from "./ChangelogView.module.css";

// ─── Category icon emoji mapping ────────────────────────

const CATEGORY_ICON_EMOJI: Record<ChangeCategoryType, string> = {
  feat: "\u2728",
  fix: "\uD83D\uDC1B",
  change: "\uD83D\uDD04",
  security: "\uD83D\uDD12",
  perf: "\u26A1",
  tech: "\uD83D\uDD27",
  stability: "\uD83D\uDEE1\uFE0F",
  uiux: "\uD83C\uDFA8",
  other: "\uD83D\uDCE6",
};

/** 收起状态下每个分类最多显示的条目数 */
const COLLAPSED_ITEMS = 2;

// ─── Props ──────────────────────────────────────────────

interface ChangelogViewProps {
  currentVersion: string;
  /** 最多显示的版本数（默认 10） */
  maxEntries?: number;
}

// ─── Component ──────────────────────────────────────────

export function ChangelogView({ currentVersion, maxEntries = 10 }: ChangelogViewProps) {
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (CHANGELOG.length > 0) initial.add(CHANGELOG[0].version);
    return initial;
  });

  const entries = useMemo(() => {
    const sorted = [...CHANGELOG].sort((a: ChangelogEntry, b: ChangelogEntry) =>
      compareVersions(b.version, a.version),
    );
    return sorted.slice(0, maxEntries);
  }, [maxEntries]);

  const toggleExpand = (version: string) => {
    setExpandedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  if (CHANGELOG.length === 0) {
    return <div className={styles.empty}>暂无更新日志</div>;
  }

  return (
    <div className={styles.container}>
      {entries.map((entry, idx) => (
        <VersionCard
          key={entry.version}
          entry={entry}
          isCurrent={compareVersions(entry.version, currentVersion) === 0}
          isLatest={idx === 0}
          isExpanded={expandedVersions.has(entry.version)}
          onToggle={() => toggleExpand(entry.version)}
        />
      ))}
    </div>
  );
}

// ─── Version Card ───────────────────────────────────────

function VersionCard({
  entry,
  isCurrent,
  isLatest,
  isExpanded,
  onToggle,
}: {
  entry: ChangelogEntry;
  isCurrent: boolean;
  isLatest: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const itemCount = countEntryItems(entry);

  return (
    <div className={`${styles.card} ${isCurrent ? styles.cardCurrent : ""}`}>
      {/* Header */}
      <div className={styles.header} onClick={onToggle}>
        <ChevronRight
          size={13}
          className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`}
        />
        <span className={`${styles.versionBadge} ${isLatest ? styles.versionBadgeCurrent : ""}`}>
          {entry.version}
        </span>
        <span className={styles.date}>{entry.date}</span>
        {isLatest && <span className={styles.latestTag}>最新</span>}
      </div>

      {/* Expandable Body */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className={styles.body}
          >
            <div className={styles.categories}>
              {entry.categories.map((cat) => (
                <CategoryRow key={cat.type} category={cat} />
              ))}
            </div>

            {itemCount > COLLAPSED_ITEMS && (
              <button className={styles.collapseBtn} onClick={onToggle}>
                ▾ 收起
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Collapsed hint */}
      {!isExpanded && itemCount > 0 && (
        <button className={styles.collapseBtn} onClick={onToggle}>
          ▸ 展开全部 {itemCount} 项
        </button>
      )}
    </div>
  );
}

// ─── Category Row ───────────────────────────────────────

function CategoryRow({ category }: { category: ChangeCategory }) {
  const barColor = CATEGORY_COLORS[category.type];
  const icon = CATEGORY_ICON_EMOJI[category.type];

  const items = category.items ?? [];
  const groupItems = category.groups?.flatMap((g) => g.items) ?? [];
  const allItems = [...items, ...groupItems];

  if (allItems.length === 0) return null;

  return (
    <div className={styles.category}>
      <div className={styles.categoryIcon} style={{ background: `color-mix(in srgb, ${barColor} 10%, transparent)` }}>
        {icon}
      </div>
      <div className={styles.categoryBody}>
        <div className={styles.categoryName} style={{ color: barColor }}>
          {category.name}
        </div>
        <ul className={styles.categoryItems}>
          {allItems.map((item, idx) => (
            <li key={idx} className={styles.categoryItem}>
              {item.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
