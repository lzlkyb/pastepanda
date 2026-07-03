import { memo, useState, useCallback, useContext, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { relativeTime, detectTextType } from "@/lib/utils";
import { createCardMenuItems, CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { pasteText } from "@/lib/api";
import { Pin, ImageIcon, Link2, AtSign, Code2, Phone, FileText, Terminal, Type, Check } from "lucide-react";
import styles from "./CardList.module.css";

const PALETTE = ["#3B82F6", "#8B5CF6", "#EC4899", "#10B981", "#F59E0B", "#EF4444", "#06B6D4", "#6366F1"];

export type ImgState = { status: "loading" | "loaded" | "error" | "silent"; url?: string };

function hashColor(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

const ICONS: Record<string, { Icon: React.FC<{ size?: number; color?: string; strokeWidth?: number }>; color: string }> = {
  text:  { Icon: Type,      color: "#6B7280" },
  link:  { Icon: Link2,     color: "#10B981" },
  email: { Icon: AtSign,    color: "#3B82F6" },
  code:  { Icon: Terminal,  color: "#8B5CF6" },
  phone: { Icon: Phone,     color: "#F59E0B" },
  image: { Icon: ImageIcon, color: "#EC4899" },
  file:  { Icon: FileText,  color: "#06B6D4" },
};

function cleanSource(source: string): string {
  if (!source) return "";
  if (/^[A-Z]:\\/i.test(source) || /^\//.test(source)) return "";
  const cleaned = source.split(/\s*[-–—]\s*/)[0].trim();
  if (cleaned.length > 20) return cleaned.slice(0, 18) + "…";
  return cleaned;
}

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
  const escaped = safeHighlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 不使用全局标志，避免 lastIndex 副作用；用 split 天然支持多段高亮
  const regex = new RegExp(`(${escaped})`, "i");
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
export const Card = memo(function Card({ item, selected, onClick, onDoubleClick, index, imageState, searchKeyword, onRetryImage, pasting, menuItems, onEdit, disablePreview }: {
  item: HistoryItem; selected: boolean; onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void; index: number; imageState?: ImgState; searchKeyword?: string; onRetryImage?: () => void; pasting?: boolean; menuItems?: MenuItem[]; onEdit?: (item: HistoryItem) => void; disablePreview?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const config = useAppStore((s) => s.config);
  const clickTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const subType = item.type === "text" ? detectTextType(item.text) : item.type;
  const cfg = ICONS[subType] || ICONS.text;
  const Icon = cfg.Icon;
  const iconColor = subType === "text" ? hashColor(item.text || "") : cfg.color;
  const time = relativeTime(item.time);
  const title = item.type === "file" ? (item.content || "文件") : (item.text || "").replace(/\r?\n/g, " ").trim() || "(空)";
  const source = cleanSource(item.source);

  const typeClass = item.type === "image" ? styles.cardImage
    : item.type === "file" ? styles.cardFile
    : item.pinned ? styles.cardPinned
    : subType === "code" ? styles.cardCode
    : styles.cardText;

  const iconBg = item.type === "image" ? styles.bgPink
    : item.type === "file" ? styles.bgGreen
    : subType === "code" ? styles.bgPurple
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
    };
  }, []);

  // 延迟关闭 Popover：给鼠标在卡片与 Popover 之间移动留缓冲时间
  const cancelCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
      closeTimerRef.current = null;
    }, 150);
  }, [cancelCloseTimer]);
  const enterHover = useCallback(() => {
    cancelCloseTimer();
    setHovered(true);
  }, [cancelCloseTimer]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只处理左键，右键留给 onContextMenu
    if (e.button !== 0) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      onDoubleClick();
    } else {
      clickTimerRef.current = window.setTimeout(() => {
        onClick(e);
        clickTimerRef.current = null;
      }, 200);
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
        className={`${styles.card} ${typeClass}${selected ? ` ${styles.selected}` : ""}`}
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
                <span className={styles.cardImgRetry} onClick={(e) => { e.stopPropagation(); onRetryImage(); }}>🔄</span>
              )}
            </div>
          ) : (
            <div className={`${styles.cardIcon} ${iconBg} ${styles.cardImgLoading}`}>
              <div className={styles.cardImgShimmer} />
            </div>
          )
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
            {source && <span className={styles.cardSource}>{source}</span>}
          </div>
        </div>

        {/* 时间 / 复制中指示器 */}
        <span className={styles.cardTime}>
          {pasting ? <span className={styles.cardPasting}><Check size={10} style={{marginRight:2}} />已复制</span> : time}
        </span>
      </motion.div>

      {/* ★ 悬停 Popover 气泡弹窗（移到卡片外部，避免被 card overflow:hidden 裁剪） */}
      {hovered && config.hover_preview_enabled && !disablePreview && (
        <CardHoverPopover item={item} imageState={imageState} subType={subType} onEdit={onEdit} onMouseEnter={enterHover} onMouseLeave={scheduleClose} />
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
  onEdit,
  onMouseEnter,
  onMouseLeave,
}: {
  item: HistoryItem;
  imageState?: ImgState;
  subType: string;
  onEdit?: (item: HistoryItem) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const togglePin = useAppStore((s) => s.togglePin);
  const removeItems = useAppStore((s) => s.removeItems);
  const { toast } = useToast();

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (item.type === "image" && item.content) {
        const { getImageBase64 } = await import("@/lib/api");
        const dataUrl = await getImageBase64(item.content);
        const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
        const base64Data = dataUrl.split(",")[1];
        const byteChars = atob(base64Data);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType });
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

  const handleFav = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    togglePin(item.id);
    toast(item.pinned ? "已取消收藏" : "已收藏", "success");
  }, [item.id, item.pinned, togglePin, toast]);

  const handleEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onEdit?.(item);
  }, [item, onEdit]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    removeItems([item.id]);
    toast("已删除，可按 Ctrl+Z 撤销", "success");
  }, [item.id, removeItems, toast]);

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
    <>
      <div
        className={styles.cardPopover}
        // 阻止 mousedown 触发卡片的单击延迟逻辑
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 预览区 */}
        {item.type === "text" && !isShortPlainText && (
          subType === "code" ? (
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
      </div>
    </>
  );
});

/** 卡片上下文包装器（右键菜单 + 操作逻辑） */
export const CardWithContext = memo(function CardWithContext({ item, selected, onClick, onDoubleClick, index, imageState, searchKeyword, onRetryImage, pasting, onEdit, disablePreview }: {
  item: HistoryItem; selected: boolean; onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void; index: number; imageState?: ImgState; searchKeyword?: string; onRetryImage?: () => void; pasting?: boolean; onEdit?: (item: HistoryItem) => void; disablePreview?: boolean;
}) {
  const { toast } = useToast();
  const togglePin = useAppStore((s) => s.togglePin);
  const removeItems = useAppStore((s) => s.removeItems);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const hasUrl = /^https?:\/\//i.test(item.text || "");

  const handleAddSnippet = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("add_snippet", { name: item.text.slice(0, 30), content: item.text });
      toast("已添加到片段库", "success");
    } catch (e) { logger.warn("添加片段失败", e); }
  }, [item.text, toast]);

  const handleOpenUrl = useCallback(async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(item.text);
    } catch (e) { logger.warn("打开URL失败", e); }
  }, [item.text]);

  const subType = item.type === "text" ? detectTextType(item.text) : item.type;

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
        case "file_bslash":
          text = content.replace(/\//g, "\\");
          break;
        case "file_fslash":
          text = content.replace(/\\/g, "/");
          break;
        case "file_list": {
          const files = parseFilePaths(content);
          text = files.join("\n");
          break;
        }
      }
      await pasteText(text);
      toast("已粘贴", "success");
    } catch { toast("粘贴失败", "error"); }
  }, [item.text, item.content, toast]);

  const menuItems = createCardMenuItems({
    onEdit: item.type === "text" && onEdit ? () => onEdit(item) : undefined,
    onCopy: async () => {
      try { await navigator.clipboard.writeText(item.text); toast("已复制到剪贴板", "success"); } catch { toast("复制失败", "error"); }
    },
    onPaste: async () => {
      try { await pasteText(item.text); toast("已粘贴", "success"); } catch { toast("粘贴失败", "error"); }
    },
    onPasteTransform: handlePasteTransform,
    itemType: item.type,
    itemSubType: subType,
    onPin: () => { togglePin(item.id); toast(item.pinned ? "已取消置顶" : "已置顶", "success"); },
    onDelete: () => setShowDeleteConfirm(true),
    onAddSnippet: handleAddSnippet,
    onOpenUrl: hasUrl ? handleOpenUrl : undefined,
    hasUrl,
    pinned: item.pinned,
  });

  return (
    <>
      <Card item={item} selected={selected} onClick={onClick} onDoubleClick={onDoubleClick} index={index} imageState={imageState} searchKeyword={searchKeyword} onRetryImage={onRetryImage} pasting={pasting} menuItems={menuItems} onEdit={onEdit} disablePreview={disablePreview} />
      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认删除"
        message={`确定要删除这条记录吗？可通过 Ctrl+Z 撤销。\n\n"${item.text?.slice(0, 80)}"`}
        confirmText="删除"
        variant="danger"
        onConfirm={() => { removeItems([item.id]); toast("已删除", "success"); setShowDeleteConfirm(false); }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </>
  );
});
