import { useSourceIcon } from "@/hooks/useSourceIcon";
import styles from "./SourceBadge.module.css";

type Size = "small" | "normal" | "large";
type Variant = "default" | "plain" | "accent";

interface SourceBadgeProps {
  source: string;
  /** 数据库中已存储的来源图标文件名（捕获剪贴板时提取） */
  sourceIcon?: string | null;
  size?: Size;
  variant?: Variant;
  /**
   * 关掉 hover 变色。给**不可点的展示位**用（如 AI 快捷栏的目标摘要行）：
   * 卡片本身可点，hover 亮底是正常反馈；摘要行点了没反应，亮底就是假的可交互暗示。
   * 静止外观与卡片完全一致，只差这一点。
   */
  noHover?: boolean;
  className?: string;
}

/** 统一来源 Badge：图标 + 清洗名称，支持三种尺寸和三种变体 */
export default function SourceBadge({ source, sourceIcon, size = "normal", variant = "default", noHover, className }: SourceBadgeProps) {
  // 提前 return 必须放在所有 hook 调用之后：source 在空/非空之间切换时（异步回填来源信息、
  // 虚拟列表复用 DOM 节点），若提前 return 跳过下面的 hook，会导致同一实例在不同渲染间 hook 调用
  // 数量不一致，React 会报 "Rendered fewer hooks than expected" 直接崩掉整个子树（问题4）
  // 双模式解析已收进 useSourceIcon（规则 #11）。
  const { displayName, emoji, realIconUrl } = useSourceIcon(source, sourceIcon);

  // hook 调用全部完成后再判空返回
  if (!source) return null;

  const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : "";
  const variantClass = variant !== "default" ? styles[variant] || "" : "";

  return (
    <span className={`${styles.badge}${sizeClass ? " " + sizeClass : ""}${variantClass ? " " + variantClass : ""}${noHover ? " " + styles.noHover : ""}${className ? " " + className : ""}`}>
      <span className={styles.icon}>
        {realIconUrl ? (
          <img src={realIconUrl} alt="" className={styles.realIcon} />
        ) : (
          emoji
        )}
      </span>
      <span className={styles.label}>{displayName}</span>
    </span>
  );
}
