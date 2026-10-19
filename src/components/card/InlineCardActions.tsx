import { memo, useCallback } from "react";
import { HistoryItem } from "@/stores/appStore";
import { type ImageOcrState } from "@/lib/utils";
import { togglePinAndDeposit } from "@/lib/notes/deposit";
import { useToast } from "@/components/Toast";
import { deleteHistory } from "@/lib/api";
import { CardActionBar } from "@/components/card/CardActionBar";
import { Pin, Pencil, Trash2 } from "lucide-react";
import styles from "../CardList.module.css";
import { usePinFlash } from "@/hooks/usePinFlash";
import { CardCopyButton } from "./CardCopyButton";

/**
 * 按钮模式：卡片内嵌操作按钮（hover 时显示）
 * - 在卡片右侧显示复制 / 置顶 / 编辑 / 删除
 * - hover 时淡入显示，时间文字淡出隐藏
 */
export const InlineCardActions = memo(function InlineCardActions({
  item,
  hovered,
  onEdit,
  ocrState,
  onCopyFeedbackChange,
}: {
  item: HistoryItem;
  hovered: boolean;
  onEdit?: (item: HistoryItem) => void;
  ocrState?: ImageOcrState;
  onCopyFeedbackChange: (visible: boolean) => void;
}) {
  const { toast } = useToast();
  const pinFlash = usePinFlash(item.pinned);


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

  return (
    <div className={`${styles.cardInlineActions} ${hovered ? styles.cardInlineVisible : ""}`} inert={!hovered}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 执行类动作条：inline 模式空间小，紧凑排列 */}
      <CardActionBar item={item} compact tabIndex={hovered ? 0 : -1} />
      <CardCopyButton item={item} className={styles.cardInlineCopy} tabIndex={hovered ? 0 : -1} onFeedbackChange={onCopyFeedbackChange} />
      {/* 🔴 图标必须与**右键菜单里同一个动作**用同一个（`cardMenuItems.tsx`）。

          旧实现用的是 emoji：☆ 📋 ✏️ 🗑，而右键菜单里同一批动作用的是 lucide 的
          Pin / Copy / Pencil / Trash2——**同一个「复制」在两个入口长得不一样**。
          三个具体代价：
            · 📋 在一个**剪贴板应用**里歧义最大：它到底是「复制这条」还是「这是剪贴板条目」？
              通用的复制图标是两个叠起来的矩形，不是剪贴板。
            · ☆ 读作「收藏」而不是「置顶」（类名至今叫 `cardInlineBtnFav`，
              说明当初就是按 favorite 选的图标，后来被改成了 pinned）。
            · emoji 由系统字体渲染：各平台长相不同、自带颜色、不跟主题走。
          图标同样适用「口径单一来源」（规则 #11）：同一个动作只能有一张脸。

          文字在 `title` 与 `aria-label` 里，并与右键菜单的条目名**逐字一致**：
          两处叫法一致，用户才能把它们认成同一件事（L5）。 */}
      <button
        type="button"
        tabIndex={hovered ? 0 : -1}
        className={`${styles.cardInlineBtn} ${styles.cardInlineBtnFav} ${item.pinned ? styles.cardInlineBtnFavActive : ""}${pinFlash ? ` ${styles.starPopping}` : ""}`}
        onClick={handleFav}
        title={item.pinned ? "取消置顶" : "置顶"}
        aria-label={item.pinned ? "取消置顶" : "置顶"}
        aria-pressed={item.pinned}
      >
        <Pin size={14} />
      </button>
      {(item.type === "text" || item.type === "diagram") && onEdit && (
        <button
          type="button"
          tabIndex={hovered ? 0 : -1}
          className={`${styles.cardInlineBtn} ${styles.cardInlineBtnEdit}`}
          onClick={handleEdit}
          title="编辑"
          aria-label="编辑"
        >
          <Pencil size={14} />
        </button>
      )}
      <button
        type="button"
        tabIndex={hovered ? 0 : -1}
        className={`${styles.cardInlineBtn} ${styles.cardInlineBtnDel}`}
        onClick={handleDelete}
        title="删除"
        aria-label="删除"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
});
