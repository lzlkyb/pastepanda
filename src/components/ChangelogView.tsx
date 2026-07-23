import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, ChevronDown } from "lucide-react";
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
// Using emoji for compact display in the history browser
// (lucide icons are used in UpdateNotesDialog for the full modal)

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

// ─── Props ──────────────────────────────────────────────

interface ChangelogViewProps {
  currentVersion: string;
  /** Optional: max entries to show (default: show all) */
  maxEntries?: number;
}

// ─── Component ──────────────────────────────────────────

export function ChangelogView({ currentVersion, maxEntries }: ChangelogViewProps) {
  const [showAll, setShowAll] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => {
    // First entry expanded by default
    const initial = new Set<string>();
    if (CHANGELOG.length > 0) {
      initial.add(CHANGELOG[0].version);
    }
    return initial;
  });

  const entries = useMemo(() => {
    // Sort descending by version
    const sorted = [...CHANGELOG].sort((a: ChangelogEntry, b: ChangelogEntry) =>
      compareVersions(b.version, a.version),
    );
    if (maxEntries && !showAll) {
      return sorted.slice(0, maxEntries);
    }
    return sorted;
  }, [maxEntries, showAll]);

  const totalEntries = CHANGELOG.length;
  const hasMore = maxEntries != null && totalEntries > maxEntries && !showAll;

  const toggleExpand = (version: string) => {
    setExpandedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) {
        next.delete(version);
      } else {
        next.add(version);
      }
      return next;
    });
  };

  if (CHANGELOG.length === 0) {
    return <div className={styles.empty}>暂无更新日志</div>;
  }

  return (
    <div className={styles.container}>
      {entries.map((entry, idx) => {
        const isCurrent = compareVersions(entry.version, currentVersion) === 0;
        const isLatest = idx === 0;
        const isExpanded = expandedVersions.has(entry.version);

        return (
          <EntryCard
            key={entry.version}
            entry={entry}
            isCurrent={isCurrent}
            isLatest={isLatest}
            isExpanded={isExpanded}
            onToggle={() => toggleExpand(entry.version)}
            totalEntries={totalEntries}
            entryIndex={idx}
          />
        );
      })}

      {hasMore && (
        <button className={styles.toggleBtn} onClick={() => setShowAll(true)}>
          <ChevronDown size={14} />
          查看全部 {totalEntries} 个版本
        </button>
      )}
    </div>
  );
}

// ─── Entry Card ─────────────────────────────────────────

function EntryCard({
  entry,
  isCurrent,
  isLatest,
  isExpanded,
  onToggle,
  totalEntries,
  entryIndex,
}: {
  entry: ChangelogEntry;
  isCurrent: boolean;
  isLatest: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  totalEntries: number;
  entryIndex: number;
}) {
  const itemCount = countEntryItems(entry);

  return (
    <div
      className={`${styles.entry} ${isCurrent ? styles.entryCurrent : ""}`}
    >
      {/* Clickable Header */}
      <div className={styles.entryHeader} onClick={onToggle}>
        <ChevronRight
          size={14}
          className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`}
        />
        <span
          className={`${styles.versionBadge} ${isLatest ? styles.versionBadgeCurrent : ""}`}
        >
          {entry.version}
        </span>
        <span className={styles.date}>{entry.date}</span>
        {isLatest && <span className={styles.latestTag}>最新</span>}
        {itemCount > 0 && (
          <span className={styles.itemCount}>{itemCount} 项</span>
        )}
      </div>

      {/* Expandable Content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className={styles.entryBody}
          >
            {/* Version Progress Bar */}
            <div className={styles.progressBar}>
              {Array.from({ length: Math.min(totalEntries, 10) }).map((_, i) => (
                <div
                  key={i}
                  className={`${styles.progressSegment} ${
                    i <= entryIndex ? styles.progressActive : styles.progressInactive
                  }`}
                />
              ))}
            </div>

            {/* Summary */}
            {entry.summary && (
              <div className={styles.entrySummary}>{entry.summary}</div>
            )}

            {/* Categories */}
            {entry.categories.map((cat) => (
              <CategorySection key={cat.type} category={cat} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Category Section ───────────────────────────────────

function CategorySection({ category }: { category: ChangeCategory }) {
  const barColor = CATEGORY_COLORS[category.type];
  const icon = CATEGORY_ICON_EMOJI[category.type];

  const sectionStyle = {
    "--bar-color": barColor,
  } as React.CSSProperties;

  return (
    <div className={styles.categorySection} style={sectionStyle}>
      <div className={styles.categoryHead} style={{ color: barColor }}>
        <span
          className={styles.categoryIcon}
          style={{ background: `${barColor}18` }}
        >
          {icon}
        </span>
        {category.name}
      </div>

      {/* Flat items */}
      {category.items && category.items.length > 0 && (
        <ul className={styles.categoryItems}>
          {category.items.map((item, idx) => (
            <li key={idx} className={styles.categoryItem}>
              {item.text}
            </li>
          ))}
        </ul>
      )}

      {/* Grouped items */}
      {category.groups &&
        category.groups.map((group, gIdx) => (
          <div key={gIdx}>
            {group.label && (
              <div className={styles.groupLabel}>{group.label}</div>
            )}
            <ul className={styles.categoryItems}>
              {group.items.map((item, idx) => (
                <li key={idx} className={styles.categoryItem}>
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
