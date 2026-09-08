import { memo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useAppStore, Tag } from "@/stores/appStore";
import { hashColor } from "@/lib/contentTypes";
import styles from "./TagBadge.module.css";

/**
 * 标签颜色唯一来源 — 全应用所有标签渲染点都必须经过这里。
 * 统一注入 --tag-c 变量，具体配色（淡底/文字/边框/hover）在 TagBadge.module.css
 * 里用 color-mix 派生，保证主题切换与交互态只需改 CSS。
 *
 * 🔴 **空串 = 未配色**，此时按标签名哈希取色（色彩规范 §3 第 3 层）。
 *
 * ❗ 这里曾经是一个**猜测**：`source !== "auto" && 颜色是那两个灰`。
 * 之所以要猜，是因为 `#6B7280` 同时背着两个含义：
 * 「文本类型的颜色」与「导入时根本没配色」。
 * 2026-09-08 把 `IMPORT_TAG_COLOR` 改成空串 + 一次数据迁移之后，
 * 「没配色」有了自己的值，猜测就删掉了。
 *
 * ❗ **现在灰只有一个含义：有人选了灰**（「日志」「纯文本」那两个 auto 标签），
 * 所以不再特殊处理——它会如实渲成灰，而那正是它想要的。
 *
 * 哈希用的是 `@/lib/palette` 里**同一套**调色盘：图标、网格封面、标签三处同源，
 * 否则同一屏里会出现三套不相干的色系。
 *
 * 🔴 返回值永远不会是空串。`TagBadge.module.css` 里用
 * `color-mix(… var(--tag-c) 12%…)` 派生淡底，而 `color-mix` 拿到空值会
 * 整条声明作废——徽标会变成无底无边。回退必须在这里完成。
 */
export function getTagStyle(tag: Tag): React.CSSProperties {
  return { "--tag-c": tag.color || hashColor(tag.name) } as React.CSSProperties;
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

/**
 * #10 标签增删动画包裹层 — TagBadge 的唯一动画入口。
 * 必须放在 <AnimatePresence initial={false}> 内使用：
 *  - 新增标签：缩放淡入落位，兄弟芯片由 layout 弹簧让位
 *  - 移除标签：快速缩放淡出（0.12s），不阻塞列表
 *  - initial={false}（由调用方提供）保证虚拟列表滚动复用行挂载时不逐个弹跳
 */
export const AnimatedTagBadge = memo(function AnimatedTagBadge(props: TagBadgeProps) {
  return (
    <motion.span
      layout
      className={styles.tagAnim}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.12, ease: "easeIn" } }}
      transition={{ type: "spring", stiffness: 520, damping: 32 }}
    >
      <TagBadge {...props} />
    </motion.span>
  );
});

/** 标签行容器 — 默认紧凑显示 max 个，hover 卡片时浮层展开全部 */
export const TagRow = memo(function TagRow({ tags, max = 2 }: {
  tags: Tag[];
  max?: number;
}) {
  const toggleTagFilter = useAppStore((s) => s.toggleTagFilter);

  // 整行消失（最后一个标签被移除）走早退分支直接卸载，不做行级退场——
  // 部分增删（常见路径）由下方 AnimatePresence 负责动画
  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <span className={styles.tagContainer}>
      {/* 紧凑行：默认显示的标签 + +N */}
      <span className={styles.tagInlineRow}>
        <AnimatePresence initial={false}>
          {visible.map((tag) => (
            <AnimatedTagBadge
              key={tag.id}
              tag={tag}
              onClick={() => toggleTagFilter(tag.id)}
            />
          ))}
        </AnimatePresence>
        {overflow > 0 && <TagBadgeMore count={overflow} />}
      </span>

      {/* hover 展开浮层：显示全部标签 */}
      {overflow > 0 && (
        <span className={styles.tagExpand}>
          <AnimatePresence initial={false}>
            {tags.map((tag) => (
              <AnimatedTagBadge
                key={tag.id}
                tag={tag}
                onClick={() => toggleTagFilter(tag.id)}
              />
            ))}
          </AnimatePresence>
        </span>
      )}
    </span>
  );
});
