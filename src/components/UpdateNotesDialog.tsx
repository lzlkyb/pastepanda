import { useMemo } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import { useDialogAnim } from "@/lib/dialogMotion";
import {
  X,
  ChevronRight,
  Download,
  Sparkles,
  Bug,
  RefreshCw,
  Shield,
  Zap,
  Wrench,
  ShieldCheck,
  Palette,
  Package,
  type LucideProps,
} from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { AppIcon } from "@/components/AppIcon";
import { useUpdate } from "@/contexts/UpdateContext";
import { CHANGELOG } from "@/lib/changelog.generated";
import {
  CATEGORY_COLORS,
  countCategoryItems,
  type ChangeCategoryType,
  type ChangeCategory,
  type ChangelogEntry,
} from "@/lib/changelog";
import type { ComponentType } from "react";
import styles from "./UpdateNotesDialog.module.css";

// ─── Category icon mapping (lucide-react) ────────────

const CATEGORY_ICON_MAP: Record<ChangeCategoryType, ComponentType<LucideProps>> = {
  feat: Sparkles,
  fix: Bug,
  change: RefreshCw,
  security: Shield,
  perf: Zap,
  tech: Wrench,
  stability: ShieldCheck,
  uiux: Palette,
  other: Package,
};

// ─── Props ──────────────────────────────────────────────

interface UpdateNotesDialogProps {
  open: boolean;
  onClose: () => void;
  currentVersion: string;
}

// ─── Component ──────────────────────────────────────────

export function UpdateNotesDialog({ open, onClose, currentVersion }: UpdateNotesDialogProps) {
  const { update, downloadAndInstall, skipThisVersion, status, progress, progressIndeterminate, bytesPerSec } = useUpdate();
  const anim = useDialogAnim();

  const entry = useMemo<ChangelogEntry | null>(() => {
    if (!update?.version) return null;
    return CHANGELOG.find((e: ChangelogEntry) => e.version === update.version) ?? null;
  }, [update?.version]);

  const isDownloading = status === "downloading";

  const handleDownload = () => {
    downloadAndInstall();
  };

  const handleSkip = () => {
    skipThisVersion();
    onClose();
  };

  return createPortal(
    <>
      {open && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop z-modal-top"
          onClick={onClose}
        >
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className="dialog-box w460"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="dialog-header">
                <h2 className="dialog-title">版本更新</h2>
                <button onClick={onClose} className="dialog-close">
                  <X size={16} />
                </button>
              </div>

              {/* Body */}
              <div className="dialog-body" style={{ padding: 0 }}>
                {/* Hero + Glow */}
                <div className={styles.heroWrap}>
                  <div className={styles.hero}>
                    <div className={styles.icon}>
                      <AppIcon size={40} className={styles.iconImg} />
                    </div>
                    <div className={styles.meta}>
                      <div className={styles.name}>PastePanda</div>
                      <div className={styles.versionRow}>
                        <span className={styles.versionBadge}>v{currentVersion}</span>
                        {update && (
                          <span className={styles.versionStatus}>
                            <span className={styles.statusDot} />
                            v{update.version} 可用
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Version Transition Card */}
                {update && (
                  <motion.div
                    className={styles.vtCard}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.06 }}
                  >
                    <span className={styles.vtOld}>v{currentVersion}</span>
                    <span className={styles.vtArrow}>
                      <ChevronRight size={14} color="#fff" strokeWidth={2.5} />
                    </span>
                    <div className={styles.vtNewWrap}>
                      <span className={styles.vtNew}>v{update.version}</span>
                      <span className={styles.vtNewPill}>NEW</span>
                    </div>
                    {entry && <span className={styles.vtDate}>{entry.date}</span>}
                  </motion.div>
                )}

                <div className={styles.gradientDivider} />

                {/* Notes Content */}
                <div className={styles.notesScroll}>
                  {entry ? (
                    <EntryContent entry={entry} />
                  ) : (
                    <FallbackContent updateBody={update?.body} />
                  )}
                </div>
              </div>

              {/* Footer Hint */}
              <div className={styles.footerHint}>
                点「跳过」此版本不再弹框；有新版本时仍会提醒
              </div>

              {/* Footer */}
              <div className="dialog-footer" style={{ justifyContent: "flex-end", height: 56 }}>
                <button className={styles.btnLater} onClick={handleSkip}>
                  跳过此版本
                </button>
                <button
                  className={styles.btnDownload}
                  onClick={handleDownload}
                  disabled={isDownloading}
                >
                  <Download size={14} />
                  {isDownloading
                    ? (progressIndeterminate ? "下载中…" : `下载中 ${progress}%`)
                    : "下载并更新"}
                </button>
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </>,
    document.body,
  );
}

// ─── Entry Content (structured changelog) ───────────────

function EntryContent({ entry }: { entry: ChangelogEntry }) {
  return (
    <>
      {/* Summary Card */}
      <motion.div
        className={styles.summary}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className={styles.summaryHead}>
          <Sparkles size={12} />
          本次更新
        </div>
        <div className={styles.summaryText}>{entry.summary}</div>
      </motion.div>

      {/* Category Stats */}
      <motion.div
        className={styles.stats}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.14 }}
      >
        {entry.categories.map((cat) => {
          const count = countCategoryItems(cat);
          if (count === 0) return null;
          return (
            <span key={cat.type} className={styles.stat}>
              <span
                className={styles.statDot}
                style={{ background: CATEGORY_COLORS[cat.type] }}
              />
              {cat.name} {count}
            </span>
          );
        })}
      </motion.div>

      {/* Category Cards */}
      {entry.categories.map((cat, i) => (
        <motion.div
          key={cat.type}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16 + i * 0.06 }}
        >
          <CategoryCard category={cat} />
        </motion.div>
      ))}
    </>
  );
}

// ─── Category Card ──────────────────────────────────────

function CategoryCard({ category }: { category: ChangeCategory }) {
  const IconComponent = CATEGORY_ICON_MAP[category.type];
  const barColor = CATEGORY_COLORS[category.type];
  const count = countCategoryItems(category);

  const cardStyle = {
    "--bar-color": barColor,
  } as React.CSSProperties;

  return (
    <div className={styles.catCard} style={cardStyle}>
      <div className={styles.catHead} style={{ color: barColor }}>
        <span
          className={styles.catIcon}
          style={{ background: `${barColor}18`, color: barColor }}
        >
          <IconComponent size={12} />
        </span>
        {category.name}
        <span className={styles.catCount}>{count}</span>
      </div>

      {/* Flat items */}
      {category.items && category.items.length > 0 && (
        <ul className={styles.catItems}>
          {category.items.map((item, idx) => (
            <li key={idx} className={styles.catItem}>
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
              <div className={styles.groupLabel} style={{ paddingLeft: 40 }}>
                {group.label}
              </div>
            )}
            <ul className={styles.catItems}>
              {group.items.map((item, idx) => (
                <li key={idx} className={styles.catItem}>
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
        ))}

      {/* ::before bar color is driven by --bar-color CSS var set on cardStyle */}
    </div>
  );
}

// ─── Fallback (no structured entry found) ───────────────

function FallbackContent({ updateBody }: { updateBody?: string | null }) {
  return (
    <div className={styles.fallback}>
      <div>暂无详细更新日志</div>
      {updateBody && <div className={styles.fallbackBody}>{updateBody}</div>}
    </div>
  );
}
