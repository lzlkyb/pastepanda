import { resolveSource, fetchRealSourceIcon } from "@/lib/source-mappings";
import { useAppStore } from "@/stores/appStore";
import { useEffect } from "react";
import styles from "./SourceBadge.module.css";

type Size = "small" | "normal" | "large";
type Variant = "default" | "plain" | "accent";

interface SourceBadgeProps {
  source: string;
  /** 数据库中已存储的来源图标文件名（捕获剪贴板时提取） */
  sourceIcon?: string | null;
  size?: Size;
  variant?: Variant;
  className?: string;
}

/** 统一来源 Badge：图标 + 清洗名称，支持三种尺寸和三种变体 */
export default function SourceBadge({ source, sourceIcon, size = "normal", variant = "default", className }: SourceBadgeProps) {
  // 提前 return 必须放在所有 hook 调用之后：source 在空/非空之间切换时（异步回填来源信息、
  // 虚拟列表复用 DOM 节点），若提前 return 跳过下面的 hook，会导致同一实例在不同渲染间 hook 调用
  // 数量不一致，React 会报 "Rendered fewer hooks than expected" 直接崩掉整个子树（问题4）
  const sourceIconMode = useAppStore((s) => s.config.source_icon_mode);
  const cacheKey = sourceIcon || source;
  const realIconUrl = useAppStore((s) => s.realIconCache[cacheKey]);
  const { displayName, icon } = resolveSource(source || "");

  // 真实图标模式：异步获取应用图标（仅当缓存中无此 key 时触发）
  useEffect(() => {
    if (source && sourceIconMode === "app") {
      fetchRealSourceIcon(source, sourceIcon);
    }
  }, [source, sourceIcon, sourceIconMode]);

  // hook 调用全部完成后再判空返回
  if (!source) return null;

  const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : "";
  const variantClass = variant !== "default" ? styles[variant] || "" : "";

  return (
    <span className={`${styles.badge}${sizeClass ? " " + sizeClass : ""}${variantClass ? " " + variantClass : ""}${className ? " " + className : ""}`}>
      <span className={styles.icon}>
        {sourceIconMode === "app" && realIconUrl ? (
          <img src={realIconUrl} alt="" className={styles.realIcon} />
        ) : (
          icon
        )}
      </span>
      <span className={styles.label}>{displayName}</span>
    </span>
  );
}
