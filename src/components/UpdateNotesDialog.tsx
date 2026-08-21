import { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import { useDialogAnim } from "@/lib/dialogMotion";
import { X, ArrowRight, Download, BookOpen } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { AppIcon } from "@/components/AppIcon";
import { useUpdate } from "@/contexts/UpdateContext";
import { CHANGELOG } from "@/lib/changelog.generated";
import { parseChangelogSection } from "@/lib/changelogParser";
import {
  CATEGORY_COLORS,
  countCategoryItems,
  setLastSeenVersion,
  isVersioned,
  type ChangelogEntry,
} from "@/lib/changelog";
import { GroupItem, FallbackContent, stripBold } from "./UpdateNotesParts";
import styles from "./UpdateNotesDialog.module.css";
import { logger } from "@/lib/logger";

/** 完整功能手册（新功能 + 全部功能详解），用户点「新功能」弹框可跳转浏览器查看。
 *  MANUAL_URL：主指向 Cloudflare Pages（国内可达性最好、正确渲染 text/html、零成本、
 *    接 GitHub 自动部署：去 Cloudflare 网页 Connect Git → 选 lzlkyb/pastepanda →
 *    生产分支 master、输出目录 docs、构建留空 → 地址即 pastepanda.pages.dev）。
 *  MANUAL_BACKUP_URL：GitHub Pages，海外兜底。
 *  注意：Gitee Pages 已于 2025 官方下线；jsDelivr 对所有 HTML 返回 text/plain 永不渲染，
 *    二者都不可用。Cloudflare 项目名须为 pastepanda 才得此域名，否则改此处。 */
const MANUAL_URL = "https://pastepanda.pages.dev/manual/index.html";
const MANUAL_BACKUP_URL = "https://lzlkyb.github.io/pastepanda/manual/index.html";

// ─── Props ──────────────────────────────────────────────

interface UpdateNotesDialogProps {
  open: boolean;
  onClose: () => void;
  currentVersion: string;
  /** 是否由「新功能」红点手动打开（无更新时）：展示最新版本说明，关闭即标记已读 */
  manual?: boolean;
}

// ─── Component ──────────────────────────────────────────

export function UpdateNotesDialog({ open, onClose, currentVersion, manual = false }: UpdateNotesDialogProps) {
  const { update, downloadAndInstall, skipThisVersion } = useUpdate();
  const anim = useDialogAnim();

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

  /** 标记某版本已读（清除红点） */
  const markSeen = useCallback((version: string) => {
    try { setLastSeenVersion(version); } catch { /* ignore */ }
  }, []);

  /** 关闭弹框：手动（红点）打开时，关闭即标记已读，清除红点 */
  const closeDialog = useCallback(() => {
    if (manual && entry && isVersioned(entry.version)) markSeen(entry.version);
    onClose();
  }, [manual, entry, markSeen, onClose]);

  const handleDownload = () => {
    // 点下载就关弹框：下载进度与“就绪后重启”由 TopBar 的 UpdateBadge 承担
    // （它已有圆环百分比 + 速率，ready 后变成「重启」按钮）。
    // 用户已主动下载更新 → 视为已读，清除红点。
    if (update?.version && isVersioned(update.version)) markSeen(update.version);
    downloadAndInstall();
    onClose();
  };

  const handleSkip = () => {
    skipThisVersion();
    onClose();
  };

  /** 打开完整功能手册（浏览器）：主 Gitee Pages，失败回退 GitHub Pages */
  const openManual = useCallback(async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      try {
        await openUrl(MANUAL_URL);
      } catch (e) {
        logger.warn("打开 Gitee 手册失败，回退 GitHub", e);
        await openUrl(MANUAL_BACKUP_URL);
      }
    } catch (e) {
      logger.warn("打开功能手册失败", e);
    }
  }, []);

  // Hero 主题句：版本摘要引语（方案 B · 发行说明式）
  const themeLine = entry ? stripBold(entry.summary) : "PastePanda 更新";
  const hasNewer = Boolean(update?.version && currentVersion && update.version !== currentVersion);

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
              <div className="dialog-body" style={{ padding: 0, gap: 0 }}>
                {/* Hero：图标 + 主题句 + 版本号（渐变强调）+ 立即更新 */}
                <div className={styles.hero}>
                  <div className={styles.heroTop}>
                    <div className={styles.icon}>
                      <AppIcon size={24} />
                    </div>
                    <div className={styles.htxt}>
                      <div className={styles.hname}>PastePanda</div>
                      <div className={styles.htitle}>{themeLine}</div>
                    </div>
                    <button onClick={closeDialog} className="dialog-close" title="关闭">
                      <X size={15} />
                    </button>
                  </div>
                  <div className={styles.hverRow}>
                    <div className={styles.hver}>
                      {hasNewer && (
                        <>
                          <span className={styles.vOld}>v{currentVersion}</span>
                          <span className={styles.vArrow}>
                            <ArrowRight size={13} strokeWidth={2.5} />
                          </span>
                        </>
                      )}
                      <span className={styles.vNew}>v{update?.version ?? entry?.version ?? currentVersion}</span>
                      <span className={styles.hpill}>NEW</span>
                    </div>
                    {update && (
                      <button className={styles.hdl} onClick={handleDownload}>
                        <Download size={13} />
                        立即更新
                      </button>
                    )}
                  </div>
                </div>

                {/* 内容：新增 / 改进 / 修复 分组卡片（发行说明式） */}
                {entry ? (
                  <div className={styles.body}>
                    {entry.categories
                      .filter((c) => countCategoryItems(c) > 0)
                      .map((cat, ci) => (
                        <motion.div
                          key={cat.type}
                          className={styles.grp}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.05 * ci, duration: 0.25, ease: "easeOut" }}
                        >
                          <div className={styles.grpHead}>
                            <span
                              className={styles.grpBadge}
                              style={{
                                background: `${CATEGORY_COLORS[cat.type]}1f`,
                                color: CATEGORY_COLORS[cat.type],
                              }}
                            >
                              {cat.name}
                            </span>
                            <span className={styles.grpTitle}>
                              {cat.name} · {countCategoryItems(cat)}
                            </span>
                          </div>
                          {(cat.items ?? []).map((item, ii) => (
                            <GroupItem key={ii} item={item} />
                          ))}
                          {(cat.groups ?? []).map((g, gi) => (
                            <div key={`g-${gi}`}>
                              {g.label && <div className={styles.grpSub}>{g.label}</div>}
                              {g.items.map((item, ii) => (
                                <GroupItem key={ii} item={item} />
                              ))}
                            </div>
                          ))}
                        </motion.div>
                      ))}
                  </div>
                ) : (
                  <FallbackContent updateBody={update?.body} />
                )}

                {/* 完整功能手册跳转：本次更新亮点 + 全部功能详解，浏览器查看 */}
                <button className={styles.manualCta} onClick={openManual} title="在新窗口查看完整功能手册">
                  <BookOpen size={14} />
                  <span className={styles.manualCtaText}>本次更新亮点 + 全部功能详解，查看完整手册</span>
                  <ArrowRight size={13} />
                </button>

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
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </>,
    document.body,
  );
}
