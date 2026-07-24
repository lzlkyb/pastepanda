import { memo, useCallback } from "react";
import { X } from "lucide-react";
import { useAppStore, Tag } from "@/stores/appStore";
import styles from "./TagBadge.module.css";

/**
 * 标签颜色唯一来源 — 全应用所有标签渲染点都必须经过这里。
 * 改标签配色只需改这一个函数。
 */
export function getTagStyle(tag: Tag): React.CSSProperties {
  return {
    background: tag.color + "20",
    color: tag.color,
    borderColor: tag.color + "40",
  };
}

export type TagBadgeVariant = "card" | "chip" | "picker";

interface TagBadgeProps {
  tag: Tag;
  /** card=卡片内紧凑徽标 | chip=带×移除按钮 | picker=选择器行(dot+名称+✓) */
  variant?: TagBadgeVariant;
  onClick?: (tag: Tag) => void;
  /** chip 变体：点 × 移除 */
  onRemove?: (tag: Tag) => void;
  /** picker 变体：选中态 */
  active?: boolean;
  /** 透传 tabIndex（对话框内防抢焦点用 -1） */
  tabIndex?: number;
}

/** 标签徽标 — 全应用唯一标签渲染组件 */
export const TagBadge = memo(function TagBadge({
  tag,
  variant = "card",
  onClick,
  onRemove,
  active = false,
  tabIndex,
}: TagBadgeProps) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onClick?.(tag);
  }, [tag, onClick]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onRemove?.(tag);
  }, [tag, onRemove]);

  const isAuto = tag.source === "auto";

  /* ===== picker 变体：选择器行 ===== */
  if (variant === "picker") {
    return (
      <button
        type="button"
        className={`${styles.pickerItem} ${active ? styles.pickerItemActive : ""}`}
        onClick={handleClick}
        tabIndex={tabIndex}
        title={`${isAuto ? "🤖 智能标签: " : ""}${tag.name}`}
      >
        <span className={styles.pickerDot} style={{ background: tag.color }} />
        {isAuto && <span className={styles.pickerAiIcon}>🤖</span>}
        <span className={styles.pickerName}>{tag.name}</span>
        <span className={styles.pickerCheck}>{active ? "✓" : ""}</span>
      </button>
    );
  }

  /* ===== card / chip 变体 ===== */
  return (
    <span
      className={`${styles.badge} ${variant === "chip" ? styles.chip : ""} ${isAuto ? styles.autoBadge : ""}`}
      style={getTagStyle(tag)}
      onClick={onClick ? handleClick : undefined}
      title={`${isAuto ? "🤖 智能" : ""}标签: ${tag.name}`}
    >
      {isAuto && <span className={styles.aiIcon}>🤖</span>}
      {variant === "chip" ? `#${tag.name}` : tag.name}
      {variant === "chip" && onRemove && (
        <button type="button" className={styles.removeBtn} onClick={handleRemove} tabIndex={tabIndex} title="移除">
          <X size={10} />
        </button>
      )}
    </span>
  );
});

/** 标签溢出指示器 — 显示 "+N" */
export const TagBadgeMore = memo(function TagBadgeMore({ count }: { count: number }) {
  return (
    <span className={styles.more}>+{count}</span>
  );
});

/** 标签行容器 — 默认紧凑显示 max 个，hover 卡片时浮层展开全部 */
export const TagRow = memo(function TagRow({ tags, max = 2 }: {
  tags: Tag[];
  max?: number;
}) {
  const toggleTagFilter = useAppStore((s) => s.toggleTagFilter);

  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <span className={styles.tagContainer}>
      {/* 紧凑行：默认显示的标签 + +N */}
      <span className={styles.tagInlineRow}>
        {visible.map((tag) => (
          <TagBadge
            key={tag.id}
            tag={tag}
            onClick={() => toggleTagFilter(tag.id)}
          />
        ))}
        {overflow > 0 && <TagBadgeMore count={overflow} />}
      </span>

      {/* hover 展开浮层：显示全部标签 */}
      {overflow > 0 && (
        <span className={styles.tagExpand}>
          {tags.map((tag) => (
            <TagBadge
              key={tag.id}
              tag={tag}
              onClick={() => toggleTagFilter(tag.id)}
            />
          ))}
        </span>
      )}
    </span>
  );
});
