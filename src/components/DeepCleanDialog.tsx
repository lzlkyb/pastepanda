/**
 * DeepCleanDialog.tsx — 深度清理弹窗（方案 A：组合条件 + 实时计数 + 预览）。
 *
 * 由设置页「数据管理 → 深度清理」行打开：
 * - 三组条件：时间范围（全部 / 超过 7·30·90 天）× 类型（全部 / 文本 / 图片 / 文件）× 来源应用（下拉）
 * - 实时计数：后端 SQL 精确 COUNT，与删除共用同一 WHERE（count = 实际清理数）
 * - 预览：展开查看命中记录前 50 条，确认后再删
 * - 删除：写入撤销栈（Ctrl+Z 撤销）；置顶记录始终跳过（后端 WHERE 固定 pinned=0）
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Target, ChevronRight, ChevronDown, Loader2, Check } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useToast } from "@/components/Toast";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import { fetchSidebarCounts } from "@/lib/api";
import SourceBadge from "@/components/SourceBadge";
import {
  countHistoryConditions,
  previewHistoryConditions,
  clearHistoryConditions,
} from "@/lib/api/history";
import { logger } from "@/lib/logger";
import styles from "./DeepClean.module.css";

const TIME_OPTIONS: { label: string; value: number | null }[] = [
  { label: "全部", value: null },
  { label: "超过 7 天", value: 7 },
  { label: "超过 30 天", value: 30 },
  { label: "超过 90 天", value: 90 },
];

const TYPE_OPTIONS: { label: string; value: string }[] = [
  { label: "全部", value: "all" },
  { label: "文本", value: "text" },
  { label: "图片", value: "image" },
  { label: "文件", value: "file" },
];

const TYPE_EMOJI: Record<string, string> = { text: "📝", image: "🖼", file: "📁" };

interface DeepCleanDialogProps {
  open: boolean;
  onClose: () => void;
}

export function DeepCleanDialog({ open, onClose }: DeepCleanDialogProps) {
  const anim = useDialogAnim();
  const { toast } = useToast();

  // ── 条件状态 ──
  const [days, setDays] = useState<number | null>(null);
  const [itemType, setItemType] = useState("all");
  const [source, setSource] = useState("all");
  /** 条件序列化键：作 effect 依赖，避免对象引用变化导致重复查询 */
  const condKey = `${days ?? "all"}|${itemType}|${source}`;

  // ── 实时计数 ──
  const [count, setCount] = useState(0);
  const [counting, setCounting] = useState(false);

  // ── 来源下拉数据（复用侧边栏聚合计数，后端 GROUP BY 全量统计） ──
  // sourceIcon 传给 SourceBadge，真实图标模式下可取到应用图标
  const [sources, setSources] = useState<{ source: string; count: number; sourceIcon: string | null }[]>([]);

  // ── 来源下拉开合（TopBar 同款：触发按钮 + portal 浮层，避开 dialog-body 的 overflow 裁剪） ──
  const [srcOpen, setSrcOpen] = useState(false);
  const srcTriggerRef = useRef<HTMLButtonElement>(null);
  const srcPopupRef = useRef<HTMLDivElement>(null);

  // ── 预览 ──
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewItems, setPreviewItems] = useState<HistoryItem[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [cleaning, setCleaning] = useState(false);

  // 打开时重置条件与预览，并加载来源列表
  useEffect(() => {
    if (!open) return;
    setDays(null);
    setItemType("all");
    setSource("all");
    setCount(0);
    setPreviewOpen(false);
    setPreviewItems([]);
    setSrcOpen(false);
    let cancelled = false;
    (async () => {
      try {
        const ws = useAppStore.getState().config.current_workspace;
        const sc = await fetchSidebarCounts(ws);
        if (!cancelled) {
          setSources(
            sc.sources
              .filter((s) => s.source)
              .sort((a, b) => b.count - a.count)
              .map((s) => ({ source: s.source, count: s.count, sourceIcon: s.source_icon })),
          );
        }
      } catch (e) {
        logger.warn("加载来源列表失败", e);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // 条件变化 → 收起预览（旧预览已失效）并重新计数
  useEffect(() => {
    if (!open) return;
    setPreviewOpen(false);
    setPreviewItems([]);
    setCounting(true);
    let cancelled = false;
    (async () => {
      try {
        const n = await countHistoryConditions({ beforeDays: days, itemType, source });
        if (!cancelled) setCount(n);
      } catch (e) {
        logger.warn("统计匹配记录数失败", e);
        if (!cancelled) setCount(0);
      } finally {
        if (!cancelled) setCounting(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, condKey]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 来源浮层定位：portal 到 body + fixed，绘制前同步测量（无闪烁），
  // 下方放不下则翻转到触发按钮上方，仍放不下则限高内部滚动
  useLayoutEffect(() => {
    if (!srcOpen) return;
    const el = srcPopupRef.current;
    const trigger = srcTriggerRef.current;
    if (!el || !trigger) return;
    const margin = 8;
    const gap = 4;
    const rect = trigger.getBoundingClientRect();
    el.style.left = `${rect.left}px`;
    el.style.width = `${rect.width}px`;
    el.style.maxHeight = "";
    el.style.top = "0px";
    const h = el.offsetHeight;
    let top = rect.bottom + gap;
    if (top + h > window.innerHeight - margin) {
      const upTop = rect.top - gap - h;
      if (upTop >= margin) {
        top = upTop;
      } else {
        el.style.maxHeight = `${Math.max(120, window.innerHeight - margin - top)}px`;
      }
    }
    el.style.top = `${top}px`;
  }, [srcOpen, sources]);

  // 点击浮层与触发按钮之外 → 关闭
  useEffect(() => {
    if (!srcOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (srcTriggerRef.current?.contains(t)) return;
      if (srcPopupRef.current?.contains(t)) return;
      setSrcOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [srcOpen]);

  // 展开 / 收起预览（展开时懒加载命中记录前 50 条）
  const togglePreview = useCallback(async () => {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    setPreviewLoading(true);
    try {
      const items = await previewHistoryConditions({ beforeDays: days, itemType, source }, 50);
      setPreviewItems(items);
    } catch (e) {
      logger.warn("加载预览失败", e);
      setPreviewItems([]);
    } finally {
      setPreviewLoading(false);
    }
  }, [previewOpen, days, itemType, source]);

  // 执行清理（弹窗本身即确认流程：大数字 + 预览，不再二次确认）
  const handleClean = useCallback(async () => {
    if (count <= 0 || cleaning) return;
    setCleaning(true);
    try {
      const n = await clearHistoryConditions({ beforeDays: days, itemType, source });
      toast(`已清理 ${n} 条记录（Ctrl+Z 撤销）`, "success");
      onClose();
    } catch (e) {
      logger.warn("深度清理失败", e);
      toast("清理失败", "error");
    } finally {
      setCleaning(false);
    }
  }, [count, cleaning, days, itemType, source, toast, onClose]);

  /** 当前选中的来源条目（触发按钮上显示图标 + 清洗名 + 条数） */
  const selectedSource = source === "all" ? null : sources.find((s) => s.source === source) ?? null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className="dialog-box w420"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="dialog-header">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className={styles.headerIcon}><Target size={15} /></span>
                  <h2 className="dialog-title">深度清理</h2>
                </div>
                <button onClick={onClose} className="dialog-close"><X size={16} /></button>
              </div>

              {/* Body：三组条件 + 匹配结果 + 预览 */}
              <div className="dialog-body" style={{ "--dialog-body-gap": "12px" } as React.CSSProperties}>
                <div className={styles.condGroup}>
                  <div className={styles.condLabel}>时间范围</div>
                  <div className={styles.chips}>
                    {TIME_OPTIONS.map((opt) => (
                      <button
                        key={opt.label}
                        className={`${styles.chip}${days === opt.value ? ` ${styles.chipActive}` : ""}`}
                        onClick={() => setDays(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.condGroup}>
                  <div className={styles.condLabel}>类型</div>
                  <div className={styles.chips}>
                    {TYPE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        className={`${styles.chip}${itemType === opt.value ? ` ${styles.chipActive}` : ""}`}
                        onClick={() => setItemType(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.condGroup}>
                  <div className={styles.condLabel}>来源应用</div>
                  <button
                    ref={srcTriggerRef}
                    type="button"
                    className={`${styles.srcTrigger}${srcOpen ? ` ${styles.srcTriggerOpen}` : ""}`}
                    onClick={() => setSrcOpen((v) => !v)}
                  >
                    {selectedSource ? (
                      <SourceBadge source={selectedSource.source} sourceIcon={selectedSource.sourceIcon} variant="plain" />
                    ) : (
                      <span className={styles.srcAllLabel}>全部来源</span>
                    )}
                    {selectedSource && (
                      <span className={styles.srcTriggerCount}>{selectedSource.count} 条</span>
                    )}
                    <ChevronDown
                      size={13}
                      className={styles.srcTriggerArr}
                      style={{ transform: srcOpen ? "rotate(180deg)" : "none" }}
                    />
                  </button>
                  {/* 浮层 portal 到 body + fixed 定位（避开 dialog-body 的 overflow 裁剪） */}
                  {srcOpen && createPortal(
                    <div ref={srcPopupRef} className={styles.srcPopup}>
                      <button
                        type="button"
                        className={`${styles.srcItem}${source === "all" ? ` ${styles.srcItemActive}` : ""}`}
                        onClick={() => { setSource("all"); setSrcOpen(false); }}
                      >
                        <span className={styles.srcAllLabel}>全部来源</span>
                        {source === "all" && <span className={styles.srcItemCheck}><Check size={12} /></span>}
                      </button>
                      {sources.map((s) => (
                        <button
                          key={s.source}
                          type="button"
                          className={`${styles.srcItem}${source === s.source ? ` ${styles.srcItemActive}` : ""}`}
                          onClick={() => { setSource(s.source); setSrcOpen(false); }}
                        >
                          <SourceBadge source={s.source} sourceIcon={s.sourceIcon} variant="plain" />
                          <span className={styles.srcItemCount}>{s.count} 条</span>
                          {source === s.source && <span className={styles.srcItemCheck}><Check size={12} /></span>}
                        </button>
                      ))}
                    </div>,
                    document.body,
                  )}
                </div>

                <div className={styles.matchBox}>
                  {counting ? (
                    <span className={styles.matchNum} style={{ color: "var(--text-muted)" }}>
                      <Loader2 size={22} className="spin-icon" />
                    </span>
                  ) : (
                    <span className={styles.matchNum}>{count}</span>
                  )}
                  <div className={styles.matchMeta}>
                    <div className={styles.matchLabel}>条记录符合条件</div>
                    <div className={styles.matchDesc}>自动跳过置顶记录 · 删除后可 Ctrl+Z 撤销</div>
                  </div>
                  <button className={styles.previewLink} onClick={() => void togglePreview()}>
                    {previewOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {previewOpen ? "收起" : "预览"}
                  </button>
                </div>

                {previewOpen && (
                  <div className={styles.previewList}>
                    {previewLoading ? (
                      <div className={styles.previewEmpty}>加载中…</div>
                    ) : previewItems.length === 0 ? (
                      <div className={styles.previewEmpty}>没有匹配的记录</div>
                    ) : (
                      previewItems.map((item) => (
                        <div key={item.id} className={styles.previewRow}>
                          <span className={styles.previewType}>
                            {TYPE_EMOJI[item.type] ?? "📝"}
                          </span>
                          <span className={styles.previewText}>
                            {item.text || item.content || "（无内容）"}
                          </span>
                          <span className={styles.previewMeta}>
                            {item.source || "未知"} · {item.time.split(" ")[0]}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="dialog-footer">
                <button className="btn-secondary" onClick={onClose}>取消</button>
                <button
                  className={`btn-danger ${styles.dangerBtn}`}
                  onClick={() => void handleClean()}
                  disabled={count <= 0 || counting || cleaning}
                >
                  {cleaning ? "清理中…" : `清理 ${count} 条记录`}
                </button>
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
