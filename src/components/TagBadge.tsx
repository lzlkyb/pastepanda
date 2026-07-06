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

  return (
    <span
      className={styles.badge}
      style={{ background: tag.color + "20", color: tag.color, borderColor: tag.color + "40" }}
      onClick={handleClick}
      title={`筛选标签: ${tag.name}`}
    >
      #{tag.name}
    </span>
  );
});

/** 标签溢出指示器 — 显示 "+N" */
export const TagBadgeMore = memo(function TagBadgeMore({ count }: { count: number }) {
  return (
    <span className={styles.more}>+{count}</span>
  );
});

/** 标签行容器 — 在卡片中显示标签列表，最多显示 max 个，超出显示 +N */
export const TagRow = memo(function TagRow({ tags, max = 3 }: {
  tags: Tag[];
  max?: number;
}) {
  const toggleTagFilter = useAppStore((s) => s.toggleTagFilter);

  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <div className={styles.row}>
      {visible.map((tag) => (
        <TagBadge
          key={tag.id}
          tag={tag}
          onClick={() => toggleTagFilter(tag.id)}
        />
      ))}
      {overflow > 0 && <TagBadgeMore count={overflow} />}
    </div>
  );
});
