import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import { useDialogAnim } from "@/lib/dialogMotion";
import { X, ArrowRight, Download } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { AppIcon } from "@/components/AppIcon";
import { useUpdate } from "@/contexts/UpdateContext";
import { CHANGELOG } from "@/lib/changelog.generated";
import {
  CATEGORY_COLORS,
  countCategoryItems,
  type ChangeCategoryType,
  type ChangelogEntry,
} from "@/lib/changelog";
import styles from "./UpdateNotesDialog.module.css";

// ─── Props ──────────────────────────────────────────────

interface UpdateNotesDialogProps {
  open: boolean;
  onClose: () => void;
  currentVersion: string;
}

/** 分类筛选：全部 或 单个分类 */
type Filter = "all" | ChangeCategoryType;

/** chip 数据（仅含有内容的分类） */
interface ChipInfo {
  type: ChangeCategoryType;
  name: string;
  color: string;
  count: number;
}

/** 时间线展平行：分组标签行 或 条目行（条目携带分类信息用于筛选与着色） */
type TimelineRow =
  | { kind: "label"; catType: ChangeCategoryType; text: string }
  | { kind: "item"; catType: ChangeCategoryType; catName: string; color: string; text: string };

// ─── Component ──────────────────────────────────────────

export function UpdateNotesDialog({ open, onClose, currentVersion }: UpdateNotesDialogProps) {
  const { update, downloadAndInstall, skipThisVersion, status, progress, progressIndeterminate } =
    useUpdate();
  const anim = useDialogAnim();
  const [filter, setFilter] = useState<Filter>("all");

  const entry = useMemo<ChangelogEntry | null>(() => {
    if (!update?.version) return null;
    return CHANGELOG.find((e: ChangelogEntry) => e.version === update.version) ?? null;
  }, [update?.version]);

  // 版本变化时重置筛选（组件常驻挂载，状态不随 open/close 重置）
  useEffect(() => {
    setFilter("all");
  }, [entry?.version]);

  const isDownloading = status === "downloading";

  // 分类 chips + 总条数
  const chipData = useMemo<{ chips: ChipInfo[]; total: number }>(() => {
    if (!entry) return { chips: [], total: 0 };
    const chips = entry.categories
      .map((cat) => ({
        type: cat.type,
        name: cat.name,
        color: CATEGORY_COLORS[cat.type],
        count: countCategoryItems(cat),
      }))
      .filter((c) => c.count > 0);
    return { chips, total: chips.reduce((s, c) => s + c.count, 0) };
  }, [entry]);

  // 分类展平为时间线行（分组标签独立成行，与条目一起按分类筛选）
  const rows = useMemo<TimelineRow[]>(() => {
    if (!entry) return [];
    const out: TimelineRow[] = [];
    for (const cat of entry.categories) {
      if (countCategoryItems(cat) === 0) continue;
      const color = CATEGORY_COLORS[cat.type];
      for (const item of cat.items ?? []) {
        out.push({ kind: "item", catType: cat.type, catName: cat.name, color, text: item.text });
      }
      for (const group of cat.groups ?? []) {
        if (group.label) out.push({ kind: "label", catType: cat.type, text: group.label });
        for (const item of group.items) {
          out.push({ kind: "item", catType: cat.type, catName: cat.name, color, text: item.text });
        }
      }
    }
    return out;
  }, [entry]);

  const isVisible = (catType: ChangeCategoryType) => filter === "all" || filter === catType;

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
              {/* Body */}
              <div className="dialog-body" style={{ padding: 0, gap: 0 }}>
                {/* 顶部：渐变洗色 + 紧凑 header 行 */}
                <div className={styles.top}>
                  <div className={styles.topRow}>
                    <div className={styles.icon}>
                      <AppIcon size={22} className={styles.iconImg} />
                    </div>
                    <div className={styles.meta}>
                      <div className={styles.name}>PastePanda</div>
                      <div className={styles.vrow}>
                        <span className={styles.vOld}>v{currentVersion}</span>
                        <span className={styles.vArrow}>
                          <ArrowRight size={11} strokeWidth={2.5} />
                        </span>
                        {update && (
                          <>
                            <span className={styles.vNew}>v{update.version}</span>
                            <span className={styles.vNewPill}>NEW</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button onClick={onClose} className="dialog-close" title="关闭">
                      <X size={15} />
                    </button>
                  </div>
                </div>

                {entry ? (
                  <>
                    {/* 摘要引语 */}
                    <div className={styles.lead}>{entry.summary}</div>

                    {/* 分类筛选 chips */}
                    <div className={styles.chips}>
                      <button
                        className={`${styles.chip} ${filter === "all" ? styles.chipActive : ""}`}
                        onClick={() => setFilter("all")}
                      >
                        全部
                        <span className={styles.chipCount}>{chipData.total}</span>
                      </button>
                      {chipData.chips.map((c) => (
                        <button
                          key={c.type}
                          className={`${styles.chip} ${filter === c.type ? styles.chipActive : ""}`}
                          onClick={() => setFilter(c.type)}
                        >
                          <span className={styles.chipDot} style={{ background: c.color }} />
                          {c.name}
                          <span className={styles.chipCount}>{c.count}</span>
                        </button>
                      ))}
                    </div>

                    {/* 彩点时间线（内层 track 承载竖轴，保证滚动时贯穿全部内容） */}
                    <div className={styles.timeline}>
                      <div className={styles.tlTrack}>
                        {rows.map((row, i) =>
                          row.kind === "label" ? (
                            <div
                              key={i}
                              className={`${styles.tlGroup} ${isVisible(row.catType) ? "" : styles.tlHidden}`}
                            >
                              {row.text}
                            </div>
                          ) : (
                            <div
                              key={i}
                              className={`${styles.tlItem} ${isVisible(row.catType) ? "" : styles.tlHidden}`}
                            >
                              <span className={styles.tlDot} style={{ background: row.color }} />
                              <div className={styles.tlTag} style={{ color: row.color }}>
                                {row.catName}
                              </div>
                              <p className={styles.tlText}>{renderItemText(row.text)}</p>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <FallbackContent updateBody={update?.body} />
                )}
              </div>

              {/* 页脚：跳过 + 下载（进度填充一体化） */}
              <div className={styles.footer}>
                <button
                  className={styles.btnSkip}
                  onClick={handleSkip}
                  title="点「跳过」此版本不再弹框；有新版本时仍会提醒"
                >
                  跳过此版本
                </button>
                <button
                  className={styles.btnDownload}
                  onClick={handleDownload}
                  disabled={isDownloading}
                >
                  <span
                    className={styles.dlFill}
                    style={{ width: isDownloading && !progressIndeterminate ? `${progress}%` : "0%" }}
                  />
                  <span className={styles.dlLabel}>
                    <Download size={14} />
                    {isDownloading
                      ? progressIndeterminate
                        ? "下载中…"
                        : `下载中 ${progress}%`
                      : "下载并更新"}
                  </span>
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

// ─── 条目文本：「标题：」前缀加粗，提升扫读效率 ───────────

function renderItemText(text: string) {
  const m = /^(.+?)(：| — )([\s\S]+)$/.exec(text);
  if (!m) return text;
  return (
    <>
      <b>{m[1]}</b>
      {m[2]}
      {m[3]}
    </>
  );
}

// ─── Fallback（未找到结构化日志条目） ───────────────

function FallbackContent({ updateBody }: { updateBody?: string | null }) {
  return (
    <div className={styles.fallback}>
      <div>暂无详细更新日志</div>
      {updateBody && <div className={styles.fallbackBody}>{updateBody}</div>}
    </div>
  );
}
