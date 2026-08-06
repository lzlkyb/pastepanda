import { memo, useState, useCallback, useContext, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { relativeTime } from "@/lib/utils";
import { getContentTypeMeta, isCodeLike } from "@/lib/contentTypes";
import { detectColor } from "@/lib/color";
import { maskSecretText } from "@/lib/secret";
import { URL_SCHEME_RE, urlHost, urlPathname, fileUrlToLocalPath } from "@/lib/url";
import { thumbnailSourcePath } from "@/lib/richContent";
import { applicableTransforms, getTransform } from "@/lib/transforms";
import { useDialogStore } from "@/stores/dialogStore";
import type { CSSProperties } from "react";
import SourceBadge from "@/components/SourceBadge";
import { createCardMenuItems, CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { confirmAutoTags, removeItemTags } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { TagRow } from "@/components/TagBadge";
import { logger } from "@/lib/logger";
import { pasteText, togglePin, deleteHistory, copyItemToClipboard } from "@/lib/api";
import { Pin, ImageIcon, Images, Link2, AtSign, Code2, Phone, FileText, Terminal, Type, Check, Hash, Lock, Palette } from "lucide-react";
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
  rich:      Images,
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
  // 限制搜索词长度，防止过长正则导致性能问题
  const safeHighlight = highlight ? highlight.trim().slice(0, 100) : "";
  // useMemo 缓存 RegExp，避免每次渲染重新编译。
  // 必须写在下面那个 early return 之前：highlight 会随搜索框在空/非空之间来回变
  // （调用处传 searchKeyword），原实现把 hook 放在 return 之后，同一个实例的 hooks
  // 数量会 0↔1 摩擦。实测当前形状下 React 恰好容忍（只有一个 hook 且无 state），
  // 但那是运气：再给它加一个 hook 就会报"Rendered fewer/more hooks than expected"。
  const regex = useMemo(() => {
    if (!safeHighlight) return null;
    const escaped = safeHighlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(${escaped})`, "i");
  }, [safeHighlight]);
  if (!regex) return <>{text}</>;
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
/**
 * 置顶切换瞬间标记（方案 C 动画）：item.pinned 发生翻转后约 1s 内返回 true，
 * 驱动 ★ 弹跳、📌 弹出、"置顶"徽章渐显等一次性动画——
 * 仅响应真实切换，初始加载的已置顶卡片不会播放。
 */
function usePinFlash(pinned: boolean): boolean {
  const prevRef = useRef(pinned);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prevRef.current === pinned) return;
    prevRef.current = pinned;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1000);
    return () => window.clearTimeout(t);
  }, [pinned]);
  return flash;
}

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
  const pinFlash = usePinFlash(item.pinned);
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

  // 原来这里是一条按类型分支的链，但 cardImage/cardFile/cardCode/cardText 四个类
  // 在 CSS 里并不存在（只有 cardPinned 是真的），实际效果等价于下面这行。
  // 顺带修掉一个副作用：这些未定义类返回 undefined，拼进模板字符串后会在
  // DOM 里真的落下一个名为 "undefined" 的 class。
  // 图片/文件类型不加 📌 角标——保持原有行为，它们的置顶状态由下面
  // cardSub 里的「置顶」徽标体现。
  const typeClass =
    item.pinned && item.type !== "image" && item.type !== "file" ? styles.cardPinned : "";

  const iconBg = item.type === "image" ? styles.bgPink
    : item.type === "file" ? styles.bgGreen
    : item.type === "rich" ? styles.bgAmber
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
        /* #8/#9 按压·悬停微交互：必须走 framer 手势通道——motion.div 的内联 transform
           会覆盖样式表规则，CSS 里 .card:hover / .cardClickFeedback 的 transform 是死代码。
           手势自带 transition，避免继承入场 stagger 的 delay */
        whileHover={{ y: -2, scale: 1.01, transition: { type: "spring", stiffness: 500, damping: 30 } }}
        whileTap={{ scale: 0.985, transition: { duration: 0.08, ease: "easeOut" } }}
        transition={{ type: "spring", stiffness: 400, damping: 28, delay: Math.min(index * 0.003, 0.04) }}
        onMouseDown={handleMouseDown}
        className={`${styles.card} ${typeClass}${selected ? ` ${styles.selected}` : ""}${clickFeedback ? ` ${styles.cardClickFeedback}` : ""}${stackOrder ? ` ${styles.cardInStack}${stackOrder === 1 ? ` ${styles.cardStackNext}` : ""}` : ""}${stackDone ? ` ${styles.cardStackDone}` : ""}${pinFlash ? ` ${styles.cardJustPinned}` : ""}`}
        role="option"
        aria-selected={selected}
        aria-label={title.length > 80 ? title.slice(0, 80) + "…" : title}
        aria-posinset={index + 1}
        tabIndex={-1}>

        {/* 图标。rich 条目正常都带图（采集时要求片段里有 <img> 才会评为 rich），
            但用户可以在编辑时把图全删了；那种情况下根本不会去加载缩略图，
            不先排除掉会掉进下面的 loading 分支、永远转圈 */}
        {(item.type === "image" || (item.type === "rich" && thumbnailSourcePath(item))) ? (
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
              <ImageIcon size={18} color="var(--danger)" strokeWidth={2.2} />
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
          {/* 徽标顺序：置顶（状态）→ 来源应用 → 内容类型 → 标签。
              来源排在类型之前：用户看卡片时先关心“从哪来的”，再关心“是什么”。
              注：图文混排不在这里画专用徽标——它走「图文」自动标签，由下方 TagRow
              渲染，这样才能点击筛选、也才会出现在筛选标签列表里。 */}
          <div className={styles.cardSub}>
            {item.pinned && (
              <span className={styles.cardPin}>
                {config.theme === "blossom" ? "🎀" : <Pin size={7} />} 置顶
              </span>
            )}
            {item.source && <SourceBadge source={item.source} sourceIcon={item.source_icon} size="small" />}
            {parsedColor && (
              <span className={styles.colorFormatTag}>{parsedColor.format.toUpperCase()}</span>
            )}
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
  const pinFlash = usePinFlash(item.pinned);

  // 按类型分派的复制统一走 copyItemToClipboard（图片/文件/图文/纯文本），
  // 不再在本文件里重复实现——之前拷了三份，加图文类型时三处全漏
  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      toast(await copyItemToClipboard(item), "success");
    } catch {
      toast("复制失败", "error");
    }
  }, [item, toast]);

  const handleFav = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // U2：走后端持久化（原 store.togglePin 仅改本地状态，鼠标收藏重启后全部丢失）
    const pinned = await togglePin(item.id);
    // 修复：失败（返回 null）此前完全静默，星标不变且用户不知道为什么
    if (pinned !== null) toast(pinned ? "已置顶" : "已取消置顶", "success");
    else toast("置顶操作失败", "error");
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
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
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
                🔗 {urlHost(item.text)}
              </div>
              <div className={styles.cardPopoverLinkPath}>
                {urlPathname(item.text)}
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
            className={`${styles.cardPopoverBtn} ${item.pinned ? styles.cardPopoverBtnFavActive : styles.cardPopoverBtnFav}${pinFlash ? ` ${styles.starPopping}` : ""}`}
            onClick={handleFav}
            title={item.pinned ? "取消置顶" : "置顶"}
          >
            {item.pinned ? "★" : "☆"} <span>{item.pinned ? "已置顶" : "置顶"}</span>
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
  const pinFlash = usePinFlash(item.pinned);

  // 按类型分派的复制统一走 copyItemToClipboard（图片/文件/图文/纯文本），
  // 不再在本文件里重复实现——之前拷了三份，加图文类型时三处全漏
  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      toast(await copyItemToClipboard(item), "success");
    } catch {
      toast("复制失败", "error");
    }
  }, [item, toast]);

  const handleFav = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // U2：走后端持久化（原 store.togglePin 仅改本地状态，鼠标收藏重启后全部丢失）
    const pinned = await togglePin(item.id);
    // 修复：失败（返回 null）此前完全静默，星标不变且用户不知道为什么
    if (pinned !== null) toast(pinned ? "已置顶" : "已取消置顶", "success");
    else toast("置顶操作失败", "error");
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
      <button className={`${styles.cardInlineBtn} ${styles.cardInlineBtnFav} ${item.pinned ? styles.cardInlineBtnFavActive : ""}${pinFlash ? ` ${styles.starPopping}` : ""}`} onClick={handleFav} title={item.pinned ? "取消置顶" : "置顶"}>
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

  const hasUrl = URL_SCHEME_RE.test(item.text || "");

  // 前端长度防护：直接传全文 content 到后端，30MB 的粘贴会变成 30MB 的片段行，导致片段库永久卡死；
  // 超过 10 万字符（约 100KB）时截断并提示用户，不直接拒绝是为了仍能保留大部分内容可用
  const MAX_SNIPPET_LEN = 100000;
  const handleAddSnippet = useCallback(async () => {
    const full = item.text || "";
    const truncated = full.length > MAX_SNIPPET_LEN;
    const content = truncated ? full.slice(0, MAX_SNIPPET_LEN) : full;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("add_snippet", { name: item.text.slice(0, 30), content });
      toast(truncated ? "内容过长，已截取前 10 万字符并添加到片段库" : "已添加到片段库", "success");
    } catch (e) {
      logger.warn("添加片段失败", e);
      // 修复：添加失败此前完全静默，用户不知道操作没生效
      toast(`添加到片段库失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
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
    } catch (e) {
      logger.warn("确认自动标签失败", e);
      // 修复：确认失败此前完全静默，标签状态未变却用户毫无感知
      toast(`确认自动标签失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [item.id, toast]);

  const handleRemoveAutoTags = useCallback(async () => {
    try {
      if (autoTagIds.length > 0) {
        await removeItemTags([item.id], autoTagIds);
        toast("已移除自动标签", "success");
      }
    } catch (e) {
      logger.warn("移除自动标签失败", e);
      // 修复：移除失败此前完全静默，标签仍在却用户以为已移除
      toast(`移除自动标签失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [item.id, autoTagIds, toast]);

  const handleOpenUrl = useCallback(async () => {
    try {
      // file:// 链接 opener 插件默认白名单不放行，转本地路径走后端命令打开
      const localPath = fileUrlToLocalPath(item.text || "");
      if (localPath) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_file_with_system", { path: localPath });
      } else {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(item.text);
      }
    } catch (e) {
      logger.warn("打开URL失败", e);
      // 修复：打不开时此前完全静默，用户点了没反应完全不知道发生了什么
      toast(`打开失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [item.text, toast]);

  // 文件操作目标路径：
  //  - file_path 文本子类型：路径就在 item.text
  //  - file 类型：路径列表存在 item.content（JSON 数组），取第一个
  const subType = item.content_type || item.type;
  const isFilePath = item.type === "text" && subType === "file_path";
  const fileTarget = isFilePath
    ? (item.text || "").trim()
    : item.type === "file"
      ? (parseFilePaths(item.content || "")[0] || "").trim()
      : "";

  // file_path / file：系统级动作（复用 FileDetailDialog 已验证的后端命令，
  // 后端自带存在性检查与网络路径拦截，失败原因经 Err 字符串带回）
  const handleOpenFile = useCallback(async () => {
    if (!fileTarget) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_file_with_system", { path: fileTarget });
      toast("已用默认应用打开", "success");
    } catch (e) {
      toast(e?.toString?.() || "无法打开文件", "error");
    }
  }, [fileTarget, toast]);

  const handleRevealFile = useCallback(async () => {
    if (!fileTarget) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_file_location", { path: fileTarget });
    } catch (e) {
      toast(e?.toString?.() || "无法打开文件夹", "error");
    }
  }, [fileTarget, toast]);

  const canQrCode = item.type === "text" && (hasUrl || (item.text || "").length <= 300);

  const handlePasteTransform = useCallback(async (transform: string) => {
    let text = item.text || "";
    const content = item.content || "";

    try {
      switch (transform) {
        // === 图片类型（依赖 item.content，含异步读取，不走注册表） ===
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

        // === 文件类型（依赖 item.content 解析路径数组，不走注册表） ===
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

        // === 文本变换：统一走变换注册表（与枢纽/右键同一数据源） ===
        default: {
          const t = getTransform(transform);
          if (!t) {
            toast("未知变换", "error");
            return;
          }
          const r = await t.run(text);
          if (!r.ok || !r.output) {
            toast(r.message ?? "无法转换", "error");
            return;
          }
          text = r.output;
        }
      }
      // U1：仅粘贴成功时弹成功提示（pasteText 失败时已自行弹错误 toast）
      const ok = await pasteText(text);
      if (ok) toast("已粘贴", "success");
    } catch { toast("粘贴失败", "error"); }
  }, [item.text, item.content, toast]);

  // 变换枢纽：当前内容是否有可用变换（json 数组 / 按列值 等），有才显示右键入口
  const hubAvailable = useMemo(
    () => applicableTransforms({ text: item.text || "", contentType: subType }).length > 0,
    [item.text, subType],
  );
  const handleOpenHub = useCallback(() => {
    useDialogStore.getState().openHub(item);
  }, [item]);

  const menuItems = useMemo(() => createCardMenuItems({
    onEdit: item.type === "text" && onEdit ? () => onEdit(item) : undefined,
    onMarkdownPreview: item.type === "text" && subType === "markdown" && onEdit ? () => onEdit(item) : undefined,
    isMarkdown: item.type === "text" && subType === "markdown",
    onEditTags: onEditTags ? () => onEditTags(item) : undefined,
    onMoveToGroup: onMoveToGroup ? () => onMoveToGroup(item) : undefined,
    onCopy: async () => {
      try {
        toast(await copyItemToClipboard(item), "success");
      } catch {
        toast("复制失败", "error");
      }
    },
    onPaste: async () => {
      // U1：仅粘贴成功时弹成功提示（pasteText 失败时已自行弹错误 toast）
      const ok = await pasteText(item.text);
      if (ok) toast("已粘贴", "success");
    },
    onPasteTransform: handlePasteTransform,
    onOpenHub: hubAvailable ? handleOpenHub : undefined,
    itemType: item.type,
    itemSubType: subType,
    onPin: async () => {
      // U2：走后端持久化，按权威返回值提示
      const pinned = await togglePin(item.id);
      if (pinned !== null) {
        toast(pinned ? "已置顶" : "已取消置顶", "success");
      } else {
        // 修复：置顶失败时此前完全静默，星标状态未变却用户不知道发生了什么
        toast("置顶操作失败", "error");
      }
    },
    onDelete: () => { void deleteHistory([item.id]); },
    onAddSnippet: handleAddSnippet,
    onOpenUrl: hasUrl ? handleOpenUrl : undefined,
    isFilePath,
    onOpenFile: fileTarget ? handleOpenFile : undefined,
    onRevealFile: fileTarget ? handleRevealFile : undefined,
    onQrCode: canQrCode && onQrCode ? () => onQrCode(item) : undefined,
    canQrCode,
    onRegexPreview: item.type === "text" && onRegexPreview ? (ruleId: string) => onRegexPreview(item, ruleId) : undefined,
    onManageRegexRules,
    onConfirmAutoTags: hasAutoTags ? handleConfirmAutoTags : undefined,
    onRemoveAutoTags: hasAutoTags ? handleRemoveAutoTags : undefined,
    hasUrl,
    hasAutoTags,
    pinned: item.pinned,
  }), [item, subType, hasUrl, isFilePath, fileTarget, canQrCode, hasAutoTags, toast, onEdit, onEditTags, onMoveToGroup, onQrCode, onRegexPreview, onManageRegexRules, handlePasteTransform, handleOpenHub, hubAvailable, handleAddSnippet, handleOpenUrl, handleOpenFile, handleRevealFile, handleConfirmAutoTags, handleRemoveAutoTags, togglePin]);

  return (
    <Card item={item} selected={selected} onClick={onClick} onDoubleClick={onDoubleClick} index={index} imageState={imageState} searchKeyword={searchKeyword} onRetryImage={onRetryImage} pasting={pasting} menuItems={menuItems} onEdit={onEdit} disablePreview={disablePreview} stackOrder={stackOrder} stackDone={stackDone} />
  );
});
