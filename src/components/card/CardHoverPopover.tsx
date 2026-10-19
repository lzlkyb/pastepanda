import { CardCopyButton } from "@/components/card/CardCopyButton";
import { memo, useCallback, lazy, Suspense } from "react";
import { motion, useIsPresent } from "framer-motion";
import { HistoryItem } from "@/stores/appStore";
import { parseFilePaths, getImageOcrFullText, type ImageOcrState } from "@/lib/utils";
import { isCodeLike } from "@/lib/contentTypes";
import { maskSecretText } from "@/lib/secret";
import { urlHost, urlPathname } from "@/lib/url";
import { parseDiagram } from "@/lib/diagram/types";
import { togglePinAndDeposit } from "@/lib/notes/deposit";
import { useToast } from "@/components/Toast";
import { deleteHistory } from "@/lib/api";
import { CardActionBar } from "@/components/card/CardActionBar";
import { Pin, Pencil, Trash2, FileText } from "lucide-react";
import styles from "../CardList.module.css";
import type { ImgState } from "./cardTypes";
import { usePinFlash } from "@/hooks/usePinFlash";
import { copyOcrTextToClipboard } from "./cardClipboard";
import { CONTROL_TRANSITION } from "@/lib/motion";
import { useInterfaceMotion } from "@/components/MotionPolicy";

const LazyMdRenderer = lazy(() => import("@/components/MarkdownRenderer").then(m => ({ default: m.MarkdownRenderer })));

/**
 * 卡片悬停 Popover 气泡弹窗
 * - 默认在卡片上方弹出
 * - 第一项/最后一项翻转到下方
 * - 多类型适配：文本/链接/邮箱/电话/代码/图片/文件
 * - 包含操作按钮：收藏 / 复制 / 编辑 / 删除
 */
export const CardHoverPopover = memo(function CardHoverPopover({
  item,
  imageState,
  subType,
  isMd,
  onEdit,
  onMouseEnter,
  onMouseLeave,
  flipDown,
  ocrState,
  onCopyFeedbackChange,
}: {
  item: HistoryItem;
  imageState?: ImgState;
  subType: string;
  isMd?: boolean;
  onEdit?: (item: HistoryItem) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  flipDown?: boolean;
  ocrState?: ImageOcrState;
  onCopyFeedbackChange: (visible: boolean) => void;
}) {
  const { toast } = useToast();
  const present = useIsPresent();
  const motionMode = useInterfaceMotion();
  const pinFlash = usePinFlash(item.pinned);


  // 复制识别文字：完整 OCR 文本（非截断标题），收口在 copyOcrTextToClipboard
  const handleCopyOcr = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void copyOcrTextToClipboard(item, ocrState, toast);
  }, [item, ocrState, toast]);

  const handleFav = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // U2：走后端持久化 + 星标自动沉淀，全项目星标动作收口在 togglePinAndDeposit
    await togglePinAndDeposit(item, ocrState, toast);
  }, [item, ocrState, toast]);

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

  // 文件路径解析（走共享的 parseFilePaths，不再就地再写一遍 try/JSON.parse）
  const fileList: string[] = item.type === "file" ? parseFilePaths(item.content || "") : [];

  return (
    <motion.div
      exit={{ opacity: 0 }}
      transition={motionMode === "full" ? CONTROL_TRANSITION : { duration: 0 }}
      className={`${styles.cardPopover}${flipDown ? ` ${styles.flipDown}` : ""}`}
      inert={!present}
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
              {/* clamp：hover 浮层只给一眼，限高 120px。笔记预览那边不传，要读全文 */}
              <LazyMdRenderer text={item.text} compact clamp />
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
              <div className={styles.cardPopoverLinkPath}>邮箱地址 · 点击复制邮箱</div>
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
                <span className={styles.cardPopoverImageGlyph}>🖼️</span>
                <div>
                  <div className={styles.cardPopoverImageName}>
                    {item.content?.split(/[/\\]/).pop() || "图片"}
                  </div>
                  <div className={styles.cardPopoverImageCaption}>图片预览</div>
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

        {/* 执行类动作条：当前内容可执行的 top-N 动作（v6.0 复制即执行） */}
        <CardActionBar item={item} />

        {item.type === "diagram" && (() => {
          const doc = parseDiagram(item.content);
          return (
            <div className={styles.cardPopoverText}>
              <div className={styles.cardPopoverLinkHost}>📊 流程图</div>
              <div className={styles.cardPopoverLinkPath}>{doc.nodes.length} 个节点 · {doc.edges.length} 条连线</div>
            </div>
          );
        })()}

        {/* 操作按钮。图标与右键菜单、悬停操作条用同一批——
            同一个动作在三个入口里只能有一张脸（规则 #11）。 */}
        <div className={styles.cardPopoverActions}>
          <button
            type="button"
            className={`${styles.cardPopoverBtn} ${item.pinned ? styles.cardPopoverBtnFavActive : styles.cardPopoverBtnFav}${pinFlash ? ` ${styles.starPopping}` : ""}`}
            onClick={handleFav}
            title={item.pinned ? "取消置顶" : "置顶"}
            aria-pressed={item.pinned}
          >
            <Pin size={12} /> <span>{item.pinned ? "已置顶" : "置顶"}</span>
          </button>
          <CardCopyButton item={item} className={styles.cardPopoverBtn} onFeedbackChange={onCopyFeedbackChange} />
          {getImageOcrFullText(item, ocrState) && (
            <button type="button" className={`${styles.cardPopoverBtn} ${styles.cardPopoverBtnOcr}`} onClick={handleCopyOcr} title="复制识别文字">
              <FileText size={12} /> <span>复制文字</span>
            </button>
          )}
          {(item.type === "text" || item.type === "diagram") && onEdit && (
            <button type="button" className={styles.cardPopoverBtn} onClick={handleEdit} title="编辑">
              <Pencil size={12} /> <span>编辑</span>
            </button>
          )}
          <button type="button" className={`${styles.cardPopoverBtn} ${styles.cardPopoverBtnDanger}`} onClick={handleDelete} title="删除">
            <Trash2 size={12} /> <span>删除</span>
          </button>
        </div>
    </motion.div>
  );
});
