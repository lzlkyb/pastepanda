import { memo, useCallback } from "react";
import { useAppStore, Tag } from "@/stores/appStore";
import styles from "./TagBadge.module.css";

/** 单个标签徽标 — 显示在卡片上，点击可筛选 */
export const TagBadge = memo(function TagBadge({ tag, onClick }: {
  tag: Tag;
  onClick?: (tag: Tag) => void;
}) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onClick?.(tag);
  }, [tag, onClick]);

  const isAuto = tag.source === "auto";

  return (
    <span
      className={`${styles.badge} ${isAuto ? styles.autoBadge : ""}`}
      style={{ background: tag.color + "20", color: tag.color, borderColor: tag.color + "40" }}
      onClick={handleClick}
      title={`${isAuto ? "🤖 智能" : ""}标签: ${tag.name}`}
    >
      {isAuto && <span className={styles.aiIcon}>🤖</span>}
      {tag.name}
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
