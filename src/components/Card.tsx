import { memo, useState, useCallback, useContext, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { relativeTime, stripHtml } from "@/lib/utils";
import { getContentTypeMeta, isCodeLike } from "@/lib/contentTypes";
import { detectColor, toHex, toRgb, toHsl } from "@/lib/color";
import { maskSecretText } from "@/lib/secret";
import type { CSSProperties } from "react";
import SourceBadge from "@/components/SourceBadge";
import { createCardMenuItems, CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { confirmAutoTags, removeItemTags, fetchTags } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { TagRow } from "@/components/TagBadge";
import { logger } from "@/lib/logger";
import { pasteText, togglePin, deleteHistory } from "@/lib/api";
import { Pin, ImageIcon, Link2, AtSign, Code2, Phone, FileText, Terminal, Type, Check, Hash, Lock, Palette } from "lucide-react";
import styles from "./CardList.module.css";

const LazyMdRenderer = lazy(() => import("@/components/MarkdownRenderer").then(m => ({ default: m.MarkdownRenderer })));

const PALETTE = ["#3B82F6", "#8B5CF6", "#EC4899", "#10B981", "#F59E0B", "#EF4444", "#06B6D4", "#6366F1"];

export type ImgState = { status: "loading" | "loaded" | "error" | "silent"; url?: string };

function hashColor(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// content_type → 图标组件映射；颜色统一取自 getContentTypeMeta（唯一来源）
const ICONS: Record<string, React.FC<{ size?: number; color?: string; strokeWidth?: number }>> = {
  text:      Type,
  link:      Link2,
  email:     AtSign,
  phone:     Phone,
  file_path: FileText,
  code:      Terminal,
  json:      Terminal,
  config:    Terminal,
  csv:       Terminal,
  shell:     Terminal,
  log:       Terminal,
  markdown:  FileText,
  html:      Code2,
  secret:    Lock,
  number:    Hash,
  color:     Palette,
  image:     ImageIcon,
  file:      FileText,
};

/** 解析文件路径 content JSON，返回路径数组 */
function parseFilePaths(content: string): string[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === "string") return [parsed];
  } catch { /* not JSON, treat as plain path */ }
  return content ? [content] : [];
}

/** 搜索关键词高亮组件 */
export const HighlightText = memo(function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight || !highlight.trim()) return <>{text}</>;
  // 限制搜索词长度，防止过长正则导致性能问题
  const safeHighlight = highlight.trim().slice(0, 100);
  if (!safeHighlight) return <>{text}</>;
  // useMemo 缓存 RegExp，避免每次渲染重新编译
  const regex = useMemo(() => {
    const escaped = safeHighlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(${escaped})`, "i");
  }, [safeHighlight]);
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? <mark key={i} className="search-highlight">{part}</mark> : <span key={i}>{part}</span>
      )}
    </>
  );
});

/** 卡片组件（纯展示） */
export const Card = memo(function Card({ item, selected, onClick, onDoubleClick, index, imageState, searchKeyword, onRetryImage, pasting, menuItems, onEdit, disablePreview, stackOrder, stackDone }: {
  item: HistoryItem; selected: boolean; onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void; index: number; imageState?: ImgState; searchKeyword?: string; onRetryImage?: () => void; pasting?: boolean; menuItems?: MenuItem[]; onEdit?: (item: HistoryItem) => void; disablePreview?: boolean; stackOrder?: number; stackDone?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [popoverFlipDown, setPopoverFlipDown] = useState(false);
  const config = useAppStore((s) => s.config);
  const clickTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const subType = item.content_type || item.type;
  const isMd = item.type === "text" && subType === "markdown";
  const parsedColor = subType === "color" ? detectColor(item.text || "") : null;
  const Icon = ICONS[subType] || Type;
  // 颜色统一取自 contentTypes 映射；无特定 content_type 的纯文本保留原有哈希配色
  const iconColor = subType === "text" ? hashColor(item.text || "") : getContentTypeMeta(subType).color;
  const time = relativeTime(item.time);
  // MB 级文本先截断再扁平化，避免整块进 DOM / 高亮 split 拖垮列表（M24）
  const title = (() => {
    if (item.type === "file") {
      // 修复 U19：不再显示原始 JSON，解析为友好文件名（"a.txt 等 3 个文件"）
      const paths = parseFilePaths(item.content || "");
      if (paths.length === 0) return "文件";
      const firstName = paths[0].split(/[/\\]/).pop() || paths[0];
      return paths.length > 1 ? `${firstName} 等 ${paths.length} 个文件` : firstName;
    }
    // P4：密钥脱敏 — 卡片标题不展示明文，前 8 字符 + 遮罩（复制操作不受影响，仍取真实值）
    if (subType === "secret") return maskSecretText(item.text || "");
    const flat = (item.text || "").slice(0, 501).replace(/\r?\n/g, " ").trim() || "(空)";
    return flat.length > 500 ? flat.slice(0, 500) + "…" : flat;
  })();

  const typeClass = item.type === "image" ? styles.cardImage
    : item.type === "file" ? styles.cardFile
    : item.pinned ? styles.cardPinned
    : isCodeLike(subType) ? styles.cardCode
    : styles.cardText;

  const iconBg = item.type === "image" ? styles.bgPink
    : item.type === "file" ? styles.bgGreen
    : isCodeLike(subType) ? styles.bgPurple
    : styles.bgBlue;

  // ★ 通过 Context 获取 ContextMenu 的 trigger 函数，用原生 DOM 事件调用，
  //   完全不依赖 DOM 事件冒泡、dispatchEvent、React 合成事件。
  const ctxTrigger = useContext(CtxMenuCtx);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !ctxTrigger) return;
    const onCtxMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      ctxTrigger(e.clientX, e.clientY, menuItems || []);
    };
    el.addEventListener("contextmenu", onCtxMenu);
    return () => {
      el.removeEventListener("contextmenu", onCtxMenu);
    };
  }, [ctxTrigger, menuItems]);

  // 清理定时器，防止组件卸载后回调执行
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
      if (openTimerRef.current !== null) {
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
    };
  }, []);

  // 延迟关闭 Popover：给鼠标在卡片与 Popover 之间移动留缓冲时间
  const cancelCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  // U42：取消尚未触发的"延迟打开"定时器
  const cancelOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelOpenTimer(); // U42：鼠标在打开前就离开 → 取消待定的打开，避免"路过"卡片后弹层仍弹出
    cancelCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
      closeTimerRef.current = null;
    }, 150);
  }, [cancelCloseTimer, cancelOpenTimer]);
  const enterHover = useCallback(() => {
    cancelCloseTimer();
    // 修复 U21：卡片靠近视口顶部、上方空间不足时，弹层翻转到下方展开，
    // 避免被 .contentArea{overflow:hidden} 裁剪导致顶部卡片按钮够不着
    const el = cardRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setPopoverFlipDown(rect.top < 260);
    }
    // U42：意图延迟 — 鼠标停留约 180ms 才打开，避免快速划过卡片时弹层闪烁；
    // 已经打开（如从弹层移回卡片）则保持，不重复延迟
    if (hovered) return;
    cancelOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setHovered(true);
    }, 180);
  }, [cancelCloseTimer, cancelOpenTimer, hovered]);

  const [clickFeedback, setClickFeedback] = useState(false);
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只处理左键，右键留给 onContextMenu
    if (e.button !== 0) return;
    // 即时视觉反馈
    setClickFeedback(true);
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      setClickFeedback(false);
      feedbackTimerRef.current = null;
    }, 150);
    // 修复 U18：单击立即执行选中，消除 200ms 延迟；
    // 定时器仅作为"双击窗口"标记——窗口期内的第二次点击触发双击动作
    // （首次点击的选中保留，符合桌面端双击先选中的惯例）
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      onDoubleClick();
    } else {
      onClick(e);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
      }, 250);
    }
  }, [onClick, onDoubleClick]);

  return (
    <div
      className={styles.cardWrap}
      style={{ position: "relative" }}
      onMouseEnter={(e: React.MouseEvent) => {
        enterHover();
        // 提升虚拟列表项容器 z-index，确保 popover 不被相邻项遮挡
        const virtualItem = e.currentTarget.parentElement;
        if (virtualItem) (virtualItem as HTMLElement).style.zIndex = "50";
      }}
      onMouseLeave={(e: React.MouseEvent) => {
        scheduleClose();
        const virtualItem = e.currentTarget.parentElement;
        if (virtualItem) (virtualItem as HTMLElement).style.zIndex = "";
      }}
    >
      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, x: -20, scale: 0.97 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={{ opacity: 0, x: -30, scale: 0.95, transition: { duration: 0.2 } }}
        transition={{ type: "spring", stiffness: 400, damping: 28, delay: Math.min(index * 0.003, 0.04) }}
        onMouseDown={handleMouseDown}
        className={`${styles.card} ${typeClass}${selected ? ` ${styles.selected}` : ""}${clickFeedback ? ` ${styles.cardClickFeedback}` : ""}${stackOrder ? ` ${styles.cardInStack}${stackOrder === 1 ? ` ${styles.cardStackNext}` : ""}` : ""}${stackDone ? ` ${styles.cardStackDone}` : ""}`}
        role="option"
        aria-selected={selected}
        aria-label={title.length > 80 ? title.slice(0, 80) + "…" : title}
        aria-posinset={index + 1}
        tabIndex={-1}>

        {/* 图标 */}
        {item.type === "image" ? (
          imageState?.status === "loaded" && imageState.url ? (
            <div className={`${styles.cardIcon} ${styles.cardImgThumb}`}>
              <img src={imageState.url} alt="" />
            </div>
          ) : imageState?.status === "silent" ? (
            <div className={`${styles.cardIcon} ${iconBg}`}>
              <ImageIcon size={18} color="#9CA3AF" strokeWidth={2.2} />
            </div>
          ) : imageState?.status === "error" ? (
            <div className={`${styles.cardIcon} ${styles.cardImgError}`}>
              <ImageIcon size={18} color="#EF4444" strokeWidth={2.2} />
              {onRetryImage && (
                <button
                  className={styles.cardImgRetry}
                  onClick={(e) => { e.stopPropagation(); onRetryImage(); }}
                  title="重新加载"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>
              )}
            </div>
          ) : (
            <div className={`${styles.cardIcon} ${iconBg} ${styles.cardImgLoading}`}>
              <div className={styles.cardImgShimmer} />
            </div>
          )
        ) : parsedColor ? (
          <div
            className={`${styles.cardIcon} ${styles.colorIcon}`}
            style={{
              "--swatch-color": item.text.trim(),
              "--swatch-bg": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.12)`,
              "--swatch-border": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.22)`,
              "--swatch-inset": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.1)`,
            } as CSSProperties}
          >
            <div className={styles.colorDot} />
          </div>
        ) : (
          <div className={`${styles.cardIcon} ${iconBg}`}>
            <Icon size={18} color={iconColor} strokeWidth={2.2} />
          </div>
        )}

        {/* 内容 */}
        <div className={styles.cardContent}>
          <p className={styles.cardTitle}>
            <HighlightText text={title} highlight={item.type === "text" ? (searchKeyword ?? "") : ""} />
          </p>
          <div className={styles.cardSub}>
            {item.pinned && (
              <span className={styles.cardPin}>
                <Pin size={7} /> 置顶
              </span>
            )}
            {isMd && <span className="md-badge">MD</span>}
            {parsedColor && (
              <span className={styles.colorFormatTag}>{parsedColor.format.toUpperCase()}</span>
            )}
            {item.source && <SourceBadge source={item.source} sourceIcon={item.source_icon} size="small" />}
            <TagRow tags={item.tags || []} />
          </div>
        </div>

        {/* 时间 / 复制中指示器 */}
        <span className={styles.cardTime}>
          {pasting ? <span className={styles.cardPasting}><Check size={10} style={{marginRight:2}} />已复制</span> : time}
        </span>
      </motion.div>

      {/* 栈序号角标（渲染在 cardWrap 层，避免被卡片 overflow:hidden 裁剪） */}
      {stackOrder ? <span className={`${styles.stackBadge}${stackOrder === 1 ? ` ${styles.stackBadgeNext}` : ""}`}>{stackOrder}</span> : null}
      {stackDone ? <span className={`${styles.stackBadge} ${styles.stackBadgeDone}`}>✓</span> : null}

      {/* ★ 悬停 Popover 气泡弹窗（移到卡片外部，避免被 card overflow:hidden 裁剪） */}
      <AnimatePresence>
        {hovered && config.hover_mode === "popover" && !disablePreview && (
          <CardHoverPopover item={item} imageState={imageState} subType={subType} isMd={isMd} onEdit={onEdit} onMouseEnter={enterHover} onMouseLeave={scheduleClose} flipDown={popoverFlipDown} />
        )}
      </AnimatePresence>

      {/* ★ 按钮模式：卡片内嵌操作按钮 */}
      {config.hover_mode === "inline" && (
        <InlineCardActions item={item} hovered={hovered} onEdit={onEdit} />
      )}
    </div>
  );
});

/**
 * 卡片悬停 Popover 气泡弹窗
 * - 默认在卡片上方弹出
 * - 第一项/最后一项翻转到下方
 * - 多类型适配：文本/链接/邮箱/电话/代码/图片/文件
 * - 包含操作按钮：收藏 / 复制 / 编辑 / 删除
 */
const CardHoverPopover = memo(function CardHoverPopover({
  item,
  imageState,
  subType,
  isMd,
  onEdit,
  onMouseEnter,
  onMouseLeave,
  flipDown,
}: {
  item: HistoryItem;
  imageState?: ImgState;
  subType: string;
  isMd?: boolean;
  onEdit?: (item: HistoryItem) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  flipDown?: boolean;
}) {
  const { toast } = useToast();

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (item.type === "image" && item.content) {
        const { getImageBase64, dataUrlToBlob } = await import("@/lib/api");
        const dataUrl = await getImageBase64(item.content);
        const blob = await dataUrlToBlob(dataUrl);
        const mimeType = blob.type || "image/png";
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
        toast("已复制", "success");
      } else if (item.type === "file" && item.content) {
        await navigator.clipboard.writeText(item.content);
        toast("已复制路径", "success");
      } else {
        await navigator.clipboard.writeText(item.text || "");
        toast("已复制", "success");
      }
    } catch {
      toast("复制失败", "error");
    }
  }, [item, toast]);

  const handleFav = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // U2：走后端持久化（原 store.togglePin 仅改本地状态，鼠标收藏重启后全部丢失）
    const pinned = await togglePin(item.id);
    if (pinned !== null) toast(pinned ? "已收藏" : "已取消收藏", "success");
  }, [item.id, toast]);

  const handleEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onEdit?.(item);
  }, [item, onEdit]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // 修复 U11：统一走 deleteHistory（后端持久化 + 统一撤销 toast），不再仅改本地状态
    void deleteHistory([item.id]);
  }, [item.id]);

  // 短文本：无需预览，只保留操作按钮（纯文本、≤40 字符、无换行）
  const isShortPlainText = item.type === "text" && subType === "text" && (item.text?.length ?? 0) <= 40 && !item.text?.includes("\n");

  // 文件路径解析
  let fileList: string[] = [];
  if (item.type === "file") {
    try {
      const parsed = JSON.parse(item.content || "[]");
      fileList = Array.isArray(parsed) ? parsed.map(String) : (item.content ? [item.content] : []);
    } catch {
      fileList = item.content ? [item.content] : [];
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 500, damping: 35 }}
      className={`${styles.cardPopover}${flipDown ? ` ${styles.flipDown}` : ""}`}
      // 阻止 mousedown 触发卡片的单击延迟逻辑
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
        {/* 预览区 */}
        {item.type === "text" && !isShortPlainText && (
          isMd ? (
            <Suspense fallback={<div className={styles.cardPopoverText}>{(item.text || "").slice(0, 200)}</div>}>
              <LazyMdRenderer text={item.text} compact />
            </Suspense>
          ) : isCodeLike(subType) ? (
            <div className={styles.cardPopoverCode}>{item.text}</div>
          ) : subType === "link" ? (
            <div className={styles.cardPopoverText}>
              <div className={styles.cardPopoverLinkHost}>
                🔗 {(() => { try { return new URL(item.text).hostname; } catch { return item.text; } })()}
              </div>
              <div className={styles.cardPopoverLinkPath}>
                {(() => { try { return new URL(item.text).pathname; } catch { return ""; } })()}
              </div>
            </div>
          ) : subType === "email" ? (
            <div className={styles.cardPopoverText}>
              <div className={styles.cardPopoverLinkHost}>📧 {item.text}</div>
              <div className={styles.cardPopoverLinkPath}>邮箱地址 · 点击复制打开邮件</div>
            </div>
          ) : subType === "phone" ? (
            <div className={styles.cardPopoverText}>
              <div className={styles.cardPopoverLinkHost}>📞 {item.text}</div>
              <div className={styles.cardPopoverLinkPath}>电话号码</div>
            </div>
          ) : subType === "secret" ? (
            <div className={styles.cardPopoverText}>
              <div className={styles.cardPopoverLinkHost}>🔑 {maskSecretText(item.text || "")}</div>
              <div className={styles.cardPopoverLinkPath}>密钥 · 已脱敏 · 双击在编辑器中查看</div>
            </div>
          ) : (
            <div className={styles.cardPopoverText}>{item.text}</div>
          )
        )}

        {item.type === "image" && (
          <div className={styles.cardPopoverImage}>
            {imageState?.status === "loaded" && imageState.url ? (
              <img src={imageState.url} alt="" />
            ) : imageState?.status === "loading" ? (
              <div className={styles.cardPopoverImageSkeleton}>
                <div className={styles.cardImgShimmer} />
              </div>
            ) : (
              <div className={styles.cardPopoverImagePlaceholder}>
                <span style={{ fontSize: 24 }}>🖼️</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 11 }}>
                    {item.content?.split(/[/\\]/).pop() || "图片"}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.7 }}>图片预览</div>
                </div>
              </div>
            )}
          </div>
        )}

        {item.type === "file" && (
          <div className={styles.cardPopoverFile}>
            {fileList.length > 0 ? fileList.map((f, i) => {
              const name = f.split(/[/\\]/).pop() || f;
              return <div key={i}>📄 {name}</div>;
            }) : <div>📄 文件</div>}
          </div>
        )}

        {/* 操作按钮 */}
        <div className={styles.cardPopoverActions}>
          <button
            className={`${styles.cardPopoverBtn} ${item.pinned ? styles.cardPopoverBtnFavActive : styles.cardPopoverBtnFav}`}
            onClick={handleFav}
            title={item.pinned ? "取消收藏" : "收藏"}
          >
            {item.pinned ? "★" : "☆"} <span>{item.pinned ? "已收藏" : "收藏"}</span>
          </button>
          <button className={styles.cardPopoverBtn} onClick={handleCopy} title="复制">
            📋 <span>复制</span>
          </button>
          {item.type === "text" && onEdit && (
            <button className={styles.cardPopoverBtn} onClick={handleEdit} title="编辑">
              ✏️ <span>编辑</span>
            </button>
          )}
          <button className={`${styles.cardPopoverBtn} ${styles.cardPopoverBtnDanger}`} onClick={handleDelete} title="删除">
            🗑 <span>删除</span>
          </button>
        </div>
    </motion.div>
  );
});

/**
 * 按钮模式：卡片内嵌操作按钮（hover 时显示）
 * - 在卡片右侧显示 4 个操作按钮：收藏 / 复制 / 编辑 / 删除
 * - hover 时淡入显示，时间文字淡出隐藏
 */
const InlineCardActions = memo(function InlineCardActions({
  item,
  hovered,
  onEdit,
}: {
  item: HistoryItem;
  hovered: boolean;
  onEdit?: (item: HistoryItem) => void;
}) {
  const { toast } = useToast();

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (item.type === "image" && item.content) {
        const { getImageBase64, dataUrlToBlob } = await import("@/lib/api");
        const dataUrl = await getImageBase64(item.content);
        const blob = await dataUrlToBlob(dataUrl);
        const mimeType = blob.type || "image/png";
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
        toast("已复制", "success");
      } else if (item.type === "file" && item.content) {
        await navigator.clipboard.writeText(item.content);
        toast("已复制路径", "success");
      } else {
        await navigator.clipboard.writeText(item.text || "");
        toast("已复制", "success");
      }
    } catch {
      toast("复制失败", "error");
    }
  }, [item, toast]);

  const handleFav = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // U2：走后端持久化（原 store.togglePin 仅改本地状态，鼠标收藏重启后全部丢失）
    const pinned = await togglePin(item.id);
    if (pinned !== null) toast(pinned ? "已收藏" : "已取消收藏", "success");
  }, [item.id, toast]);

  const handleEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onEdit?.(item);
  }, [item, onEdit]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // 修复 U11：统一走 deleteHistory（后端持久化 + 统一撤销 toast），不再仅改本地状态
    void deleteHistory([item.id]);
  }, [item.id]);

  return (
    <div className={`${styles.cardInlineActions} ${hovered ? styles.cardInlineVisible : ""}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button className={`${styles.cardInlineBtn} ${styles.cardInlineBtnFav} ${item.pinned ? styles.cardInlineBtnFavActive : ""}`} onClick={handleFav} title={item.pinned ? "取消收藏" : "收藏"}>
        {item.pinned ? "★" : "☆"}
      </button>
      <button className={`${styles.cardInlineBtn} ${styles.cardInlineBtnCopy}`} onClick={handleCopy} title="复制">
        📋
      </button>
      {item.type === "text" && onEdit && (
        <button className={`${styles.cardInlineBtn} ${styles.cardInlineBtnEdit}`} onClick={handleEdit} title="编辑">
          ✏️
        </button>
      )}
      <button className={`${styles.cardInlineBtn} ${styles.cardInlineBtnDel}`} onClick={handleDelete} title="删除">
        🗑
      </button>
    </div>
  );
});

/** 卡片上下文包装器（右键菜单 + 操作逻辑） */
export const CardWithContext = memo(function CardWithContext({ item, selected, onClick, onDoubleClick, index, imageState, searchKeyword, onRetryImage, pasting, onEdit, onEditTags, onMoveToGroup, onQrCode, onRegexPreview, onManageRegexRules, disablePreview, stackOrder, stackDone }: {
  item: HistoryItem; selected: boolean; onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void; index: number; imageState?: ImgState; searchKeyword?: string; onRetryImage?: () => void; pasting?: boolean; onEdit?: (item: HistoryItem) => void; onEditTags?: (item: HistoryItem) => void; onMoveToGroup?: (item: HistoryItem) => void; onQrCode?: (item: HistoryItem) => void; onRegexPreview?: (item: HistoryItem, ruleId: string) => void; onManageRegexRules?: () => void; disablePreview?: boolean; stackOrder?: number; stackDone?: boolean;
}) {
  const { toast } = useToast();

  const hasUrl = /^(https?|ftp|file|ws|wss|sftp|telnet|ssh|rdp):\/\//i.test(item.text || "");

  const handleAddSnippet = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("add_snippet", { name: item.text.slice(0, 30), content: item.text });
      toast("已添加到片段库", "success");
    } catch (e) { logger.warn("添加片段失败", e); }
  }, [item.text, toast]);

  // 自动标签相关
  const hasAutoTags = useMemo(() =>
    (item.tags || []).some(t => t.source === "auto"),
  [item.tags]);
  const autoTagIds = useMemo(() =>
    (item.tags || []).filter(t => t.source === "auto").map(t => t.id),
  [item.tags]);

  const handleConfirmAutoTags = useCallback(async () => {
    try {
      await confirmAutoTags(item.id);
      toast("已确认自动标签", "success");
    } catch (e) { logger.warn("确认自动标签失败", e); }
  }, [item.id, toast]);

  const handleRemoveAutoTags = useCallback(async () => {
    try {
      if (autoTagIds.length > 0) {
        await removeItemTags([item.id], autoTagIds);
        toast("已移除自动标签", "success");
      }
    } catch (e) { logger.warn("移除自动标签失败", e); }
  }, [item.id, autoTagIds, toast]);

  const handleOpenUrl = useCallback(async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(item.text);
    } catch (e) { logger.warn("打开URL失败", e); }
  }, [item.text]);

  const subType = item.content_type || item.type;
  const canQrCode = item.type === "text" && (hasUrl || (item.text || "").length <= 300);

  const handlePasteTransform = useCallback(async (transform: string) => {
    let text = item.text || "";
    const content = item.content || "";

    try {
      switch (transform) {
        // === 文本通用变换 ===
        case "upper": text = text.toUpperCase(); break;
        case "lower": text = text.toLowerCase(); break;
        case "strip": text = text.replace(/^\s+|\s+$/g, ""); break;
        case "strip_lines": text = text.split("\n").filter((l: string) => l.trim()).join("\n"); break;
        case "quote": text = `"${text}"`; break;
        case "md_link": text = `[${text.slice(0, 30)}](${text})`; break;
        case "strip_html": text = stripHtml(text); break;

        // === 链接子类型专属 ===
        case "plain_url":
          try { text = new URL(text).hostname + new URL(text).pathname; } catch { /* keep original */ }
          break;

        // === 邮箱子类型专属 ===
        case "mailto": text = `mailto:${text.trim()}`; break;

        // === 代码子类型专属 ===
        case "code_block": text = "```\n" + text + "\n```"; break;
        case "single_line": text = text.split("\n").map((l: string) => l.trim()).join("; "); break;

        // === 电话子类型专属 ===
        case "tel": text = `tel:${text.replace(/[- ]/g, "")}`; break;
        case "phone_cn": {
          const digits = text.replace(/[- ()（）+]/g, "");
          text = digits.startsWith("86") ? `+${digits}` : `+86${digits}`;
          break;
        }

        // === 颜色子类型专属 ===
        case "color_hex": {
          const parsed = detectColor(text.trim());
          if (parsed) text = toHex(parsed);
          break;
        }
        case "color_rgb": {
          const parsed = detectColor(text.trim());
          if (parsed) text = toRgb(parsed);
          break;
        }
        case "color_hsl": {
          const parsed = detectColor(text.trim());
          if (parsed) text = toHsl(parsed);
          break;
        }

        // === 路径子类型专属（文本型 file_path） ===
        case "path_bslash": text = text.replace(/\//g, "\\"); break;
        case "path_fslash": text = text.replace(/\\/g, "/"); break;
        case "path_name": text = text.split(/[/\\]/).pop() || text; break;

        // === 图片类型 ===
        case "md_image": {
          const imgPath = content || text;
          text = `![图片](${imgPath})`;
          break;
        }
        case "img_base64": {
          // 如果 content 是本地路径，尝试读取并转 base64
          if (content) {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const b64: string = await invoke("read_file_as_base64", { path: content });
              text = `data:image/png;base64,${b64}`;
            } catch {
              // 兜底：粘贴路径
              text = content;
              toast("图片Base64转换失败，已粘贴路径", "warning");
            }
          }
          break;
        }

        // === 文件类型 ===
        case "file_name": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => f.split(/[/\\]/).pop() || f).join("\n");
          break;
        }
        case "file_dir": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => {
            const idx = Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\"));
            return idx >= 0 ? f.slice(0, idx) : ".";
          }).join("\n");
          break;
        }
        case "file_bslash": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => f.replace(/\//g, "\\")).join("\n");
          break;
        }
        case "file_fslash": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => f.replace(/\\/g, "/")).join("\n");
          break;
        }
        case "file_list": {
          const files = parseFilePaths(content);
          text = files.join("\n");
          break;
        }
      }
      // U1：仅粘贴成功时弹成功提示（pasteText 失败时已自行弹错误 toast）
      const ok = await pasteText(text);
      if (ok) toast("已粘贴", "success");
    } catch { toast("粘贴失败", "error"); }
  }, [item.text, item.content, toast]);

  const menuItems = useMemo(() => createCardMenuItems({
    onEdit: item.type === "text" && onEdit ? () => onEdit(item) : undefined,
    onMarkdownPreview: item.type === "text" && subType === "markdown" && onEdit ? () => onEdit(item) : undefined,
    isMarkdown: item.type === "text" && subType === "markdown",
    onEditTags: onEditTags ? () => onEditTags(item) : undefined,
    onMoveToGroup: onMoveToGroup ? () => onMoveToGroup(item) : undefined,
    onCopy: async () => {
      try { await navigator.clipboard.writeText(item.text); toast("已复制到剪贴板", "success"); } catch { toast("复制失败", "error"); }
    },
    onPaste: async () => {
      // U1：仅粘贴成功时弹成功提示（pasteText 失败时已自行弹错误 toast）
      const ok = await pasteText(item.text);
      if (ok) toast("已粘贴", "success");
    },
    onPasteTransform: handlePasteTransform,
    itemType: item.type,
    itemSubType: subType,
    onPin: async () => {
      // U2：走后端持久化，按权威返回值提示
      const pinned = await togglePin(item.id);
      if (pinned !== null) toast(pinned ? "已置顶" : "已取消置顶", "success");
    },
    onDelete: () => { void deleteHistory([item.id]); },
    onAddSnippet: handleAddSnippet,
    onOpenUrl: hasUrl ? handleOpenUrl : undefined,
    onQrCode: canQrCode && onQrCode ? () => onQrCode(item) : undefined,
    canQrCode,
    onRegexPreview: item.type === "text" && onRegexPreview ? (ruleId: string) => onRegexPreview(item, ruleId) : undefined,
    onManageRegexRules,
    onConfirmAutoTags: hasAutoTags ? handleConfirmAutoTags : undefined,
    onRemoveAutoTags: hasAutoTags ? handleRemoveAutoTags : undefined,
    hasUrl,
    hasAutoTags,
    pinned: item.pinned,
  }), [item, subType, hasUrl, canQrCode, hasAutoTags, toast, onEdit, onEditTags, onMoveToGroup, onQrCode, onRegexPreview, onManageRegexRules, handlePasteTransform, handleAddSnippet, handleOpenUrl, handleConfirmAutoTags, handleRemoveAutoTags, togglePin]);

  return (
    <Card item={item} selected={selected} onClick={onClick} onDoubleClick={onDoubleClick} index={index} imageState={imageState} searchKeyword={searchKeyword} onRetryImage={onRetryImage} pasting={pasting} menuItems={menuItems} onEdit={onEdit} disablePreview={disablePreview} stackOrder={stackOrder} stackDone={stackDone} />
  );
});
