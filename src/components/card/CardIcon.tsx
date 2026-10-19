import { getContentTypeMeta, hashColor, isCodeLike } from "@/lib/contentTypes";
import { detectColor } from "@/lib/color";
import { thumbnailSourcePath } from "@/lib/richContent";
import type { CSSProperties } from "react";
import { ImageIcon, Images, Link2, AtSign, Code2, Phone, FileText, Terminal, Type, Hash, Lock, Palette, Workflow } from "lucide-react";
import styles from "../CardList.module.css";
import type { CardProps } from "./cardTypes";

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
  diagram:   Workflow,
};

// 本地那份 parseFilePaths 已删：收口到 lib/utils（规则 #11）。
// 它与 pasteTransform 那份行为不一致（这份 map(String) 会把数字/null 当路径，
// 且 JSON 解析失败时把整个 content 当单路径而不按换行切）。

export function CardIcon({ item, imageState, onRetryImage }: Pick<CardProps, "item" | "imageState" | "onRetryImage">) {
  const subType = item.content_type || item.type;
  const parsedColor = subType === "color" ? detectColor(item.text || "") : null;
  const Icon = ICONS[subType] || Type;
  const iconColor = subType === "text" ? hashColor(item.text || "") : getContentTypeMeta(subType).color;
  const iconBg = item.type === "image" ? styles.bgPink
    : item.type === "file" ? styles.bgGreen
    : item.type === "rich" ? styles.bgAmber
    : item.type === "diagram" ? styles.bgBlue
    : isCodeLike(subType) ? styles.bgPurple
    : styles.bgBlue;

  return <>
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
              <ImageIcon size={18} color="var(--text-muted)" strokeWidth={2.2} />
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

  </>;
}
