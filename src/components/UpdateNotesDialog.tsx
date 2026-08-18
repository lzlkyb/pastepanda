import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import { useDialogAnim } from "@/lib/dialogMotion";
import { X, ArrowRight, Download } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { AppIcon } from "@/components/AppIcon";
import { Illustration, isIllustrationKey } from "@/components/Illustration";
import { useUpdate } from "@/contexts/UpdateContext";
import { CHANGELOG } from "@/lib/changelog.generated";
import { parseChangelogSection } from "@/lib/changelogParser";
import {
  CATEGORY_COLORS,
  countCategoryItems,
  setLastSeenVersion,
  type ChangeCategoryType,
  type ChangeItem,
  type ChangelogEntry,
} from "@/lib/changelog";
import styles from "./UpdateNotesDialog.module.css";

// ─── Props ──────────────────────────────────────────────

interface UpdateNotesDialogProps {
  open: boolean;
  onClose: () => void;
  currentVersion: string;
  /** 是否由「新功能」红点手动打开（无更新时）：展示最新版本说明，关闭即标记已读 */
  manual?: boolean;
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

// ─── Component ──────────────────────────────────────────

export function UpdateNotesDialog({ open, onClose, currentVersion, manual = false }: UpdateNotesDialogProps) {
  const { update, downloadAndInstall, skipThisVersion } = useUpdate();
  const anim = useDialogAnim();
  const [filter, setFilter] = useState<Filter>("all");

  const entry = useMemo<ChangelogEntry | null>(() => {
    if (update?.version) {
      // 包内日志优先（仅开发期/同版本场景命中）；真实更新时目标版本必然新于
      // 当前二进制，构建时打包的 CHANGELOG 不含其条目，需实时解析更新清单
      // body（CI 从同一份 CHANGELOG.md 提取，见 scripts/extract-release-notes.mjs）
      return (
        CHANGELOG.find((e: ChangelogEntry) => e.version === update.version) ??
        parseChangelogSection(update.body, update.version)
      );
    }
    // 无更新（红点手动打开）：展示最新版本说明
    return manual ? CHANGELOG[0] ?? null : null;
  }, [update?.version, update?.body, manual]);

  // 版本变化时重置筛选（组件常驻挂载，状态不随 open/close 重置）
  useEffect(() => {
    setFilter("all");
  }, [entry?.version]);

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

  const isVisible = (catType: ChangeCategoryType) => filter === "all" || filter === catType;

  /** 标记某版本已读（清除红点） */
  const markSeen = useCallback((version: string) => {
    try { setLastSeenVersion(version); } catch { /* ignore */ }
  }, []);

  /** 关闭弹框：手动（红点）打开时，关闭即标记已读，清除红点 */
  const closeDialog = useCallback(() => {
    if (manual && entry) markSeen(entry.version);
    onClose();
  }, [manual, entry, markSeen, onClose]);

  const handleDownload = () => {
    // 点下载就关弹框：下载进度与“就绪后重启”由 TopBar 的 UpdateBadge 承担
    // （它已有圆环百分比 + 速率，ready 后变成「重启」按钮）。
    // 不关的旧行为会把主界面一直挡着，而且 status 进 ready 后弹框里那个按钮
    // 会退回成「下载并更新」且可再点，看起来像什么都没发生。
    // 用户已主动下载更新 → 视为已读，清除红点。
    if (update?.version) markSeen(update.version);
    downloadAndInstall();
    onClose();
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
                        {update?.version && currentVersion && update.version !== currentVersion ? (
                          <>
                            <span className={styles.vOld}>v{currentVersion}</span>
                            <span className={styles.vArrow}>
                              <ArrowRight size={11} strokeWidth={2.5} />
                            </span>
                          </>
                        ) : null}
                        <span className={styles.vNew}>v{update?.version ?? entry?.version ?? currentVersion}</span>
                        <span className={styles.vNewPill}>NEW</span>
                      </div>
                    </div>
                    <button onClick={closeDialog} className="dialog-close" title="关闭">
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

                    {/* 功能卡片（新增且带 怎么用/有什么用/配图）+ 紧凑时间线（其余分类） */}
                    <div className={styles.timeline}>
                      {(() => {
                        const cats = entry.categories.filter(
                          (c) => isVisible(c.type) && countCategoryItems(c) > 0,
                        );
                        const featCats = cats.filter((c) => c.type === "feat");
                        const otherCats = cats.filter((c) => c.type !== "feat");
                        return (
                          <>
                            <div className={styles.featWrap}>
                              {featCats.map((cat, ci) => (
                                <div key={`feat-${ci}`}>
                                  {(cat.items ?? []).map((item, ii) => (
                                    <FeatCard key={ii} item={item} catName={cat.name} />
                                  ))}
                                  {(cat.groups ?? []).map((g, gi) => (
                                    <div key={`fg-${gi}`}>
                                      {g.label && <div className={styles.tlGroup}>{g.label}</div>}
                                      {g.items.map((item, ii) => (
                                        <FeatCard key={ii} item={item} catName={cat.name} />
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                            <div className={styles.tlTrack}>
                              {otherCats.map((cat, ci) => (
                                <div key={`oth-${ci}`}>
                                  {(cat.items ?? []).map((item, ii) => (
                                    <div key={ii} className={styles.tlItem}>
                                      <span className={styles.tlDot} style={{ background: CATEGORY_COLORS[cat.type] }} />
                                      <div className={styles.tlTag} style={{ color: CATEGORY_COLORS[cat.type] }}>
                                        {cat.name}
                                      </div>
                                      <p className={styles.tlText}>{renderItemText(item.text)}</p>
                                    </div>
                                  ))}
                                  {(cat.groups ?? []).map((g, gi) => (
                                    <div key={`og-${gi}`}>
                                      {g.label && <div className={styles.tlGroup}>{g.label}</div>}
                                      {g.items.map((item, ii) => (
                                        <div key={ii} className={styles.tlItem}>
                                          <span className={styles.tlDot} style={{ background: CATEGORY_COLORS[cat.type] }} />
                                          <div className={styles.tlTag} style={{ color: CATEGORY_COLORS[cat.type] }}>
                                            {cat.name}
                                          </div>
                                          <p className={styles.tlText}>{renderItemText(item.text)}</p>
                                        </div>
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </>
                ) : (
                  <FallbackContent updateBody={update?.body} />
                )}
              </div>

              {/* 页脚：有更新=稍后看+下载；红点手动打开=关闭（已读） */}
              <div className={styles.footer}>
                {update ? (
                  <>
                    <button
                      className={styles.btnSkip}
                      onClick={handleSkip}
                      title="点「稍后看」关闭；顶部「新功能」红点可随时回看"
                    >
                      稍后看
                    </button>
                    {/* 按钮不再兼作进度条：点下载后弹框立即关闭，下载期间它不可见
                        （open 只在 status === "available" 时置 true），原来那套
                        dlFill / “下载中 N%” 分支已永远不会命中，索性删干净 */}
                    <button className={styles.btnDownload} onClick={handleDownload}>
                      <span className={styles.dlLabel}>
                        <Download size={14} />
                        下载并更新
                      </span>
                    </button>
                  </>
                ) : (
                  <button className={styles.btnDownload} onClick={closeDialog}>
                    <span className={styles.dlLabel}>关闭（已读）</span>
                  </button>
                )}
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

// ─── 功能卡片（新增类带 怎么用/有什么用/配图） ───────────

/** 单条新增条目：带富文本则渲染为功能卡片，否则退化为紧凑时间线条目 */
function FeatCard({ item, catName }: { item: ChangeItem; catName: string }) {
  const m = /^(.+?)(：| — )([\s\S]+)$/.exec(item.text);
  const title = m ? m[1] : item.text;
  const desc = m ? m[3] : "";
  const rich = item.why || (item.how && item.how.length > 0) || item.media;
  if (!rich) {
    // 无富文本（如单纯一句新增说明）：退化为普通时间线条目，避免空白卡片
    return (
      <div className={styles.tlItem}>
        <span className={styles.tlDot} style={{ background: CATEGORY_COLORS.feat }} />
        <div className={styles.tlTag} style={{ color: CATEGORY_COLORS.feat }}>{catName}</div>
        <p className={styles.tlText}>{renderItemText(item.text)}</p>
      </div>
    );
  }
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardBadge}>{catName}</span>
        <span className={styles.cardTitle}>{title}</span>
      </div>
      {desc && <div className={styles.cardDesc}>{desc}</div>}
      {item.why && <div className={styles.cardWhy}>{item.why}</div>}
      {item.how && item.how.length > 0 && (
        <>
          <div className={styles.cardHowH}>怎么用</div>
          <ol className={styles.cardHow}>
            {item.how.map((s, hi) => (
              <li key={hi}>{s}</li>
            ))}
          </ol>
        </>
      )}
      {item.media && <MediaThumb src={item.media} />}
    </div>
  );
}

/** 配图缩略图：加载失败优雅降级为占位框（真实资源到位后自动显示） */
function MediaThumb({ src }: { src: string }) {
  const [err, setErr] = useState(false);
  const kind = isIllustrationKey(src) ? src : null;
  return (
    <div className={styles.cardMedia}>
      {kind ? (
        <Illustration kind={kind} className={styles.cardMediaImg} />
      ) : err ? (
        <Illustration kind="default" className={styles.cardMediaImg} />
      ) : (
        <img src={src} alt="" className={styles.cardMediaImg} onError={() => setErr(true)} />
      )}
    </div>
  );
}
