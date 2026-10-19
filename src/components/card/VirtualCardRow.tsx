import { memo } from "react";
import type { HistoryItem } from "@/stores/appStore";
import { CardWithContext, type ImgState } from "@/components/Card";
import { primaryModifierHeld, type ImageOcrState, type ImageBarcodeState } from "@/lib/utils";
import { thumbnailSourcePath } from "@/lib/richContent";

/**
 * 虚拟化行（memoized）— CardList 每滚动帧因 scrollMetrics 重渲染，
 * 若行内联闭包则所有可见 Card 的 memo 全部失效。改为：行组件接收稳定的
 * by-id 回调 + 原始类型标志，浅比较通过即跳过，闭包放在行内部创建。
 */
export const VirtualCardRow = memo(function VirtualCardRow({
  item, selected, current, checked, pasting, imageState, searchKeyword, stackOrder, stackDone, ocrState, barcodeState,
  index, disablePreview, showMoveToGroup,
  onItemClick, onItemDoubleClick, onRetryImage, onEdit, onEditTags,
  onQrCode, onRegexPreview, onManageRegexRules,
}: {
  item: HistoryItem;
  selected: boolean;
  current: boolean;
  checked: boolean;
  pasting: boolean;
  imageState: ImgState | undefined;
  ocrState: ImageOcrState | undefined;
  barcodeState: ImageBarcodeState | undefined;
  searchKeyword: string;
  stackOrder: number | undefined;
  stackDone: boolean;
  index: number;
  disablePreview: boolean;
  showMoveToGroup: boolean;
  onItemClick: (id: string, ctrl: boolean, shift: boolean) => void;
  onItemDoubleClick: (id: string) => void;
  onRetryImage: (content: string) => void;
  onEdit: (item: HistoryItem) => void;
  onEditTags: (item: HistoryItem) => void;
  onQrCode: (item: HistoryItem) => void;
  onRegexPreview: (item: HistoryItem, ruleId: string) => void;
  onManageRegexRules: () => void;
}) {
  return (
    <CardWithContext
      item={item} selected={selected} current={current} checked={checked}
      imageState={imageState}
      ocrState={ocrState}
      barcodeState={barcodeState}
      searchKeyword={searchKeyword}
      pasting={pasting}
      onRetryImage={(() => {
        const p = thumbnailSourcePath(item);
        return p && imageState?.status === "error" ? () => onRetryImage(p) : undefined;
      })()}
      onClick={(e: React.MouseEvent) => onItemClick(item.id, primaryModifierHeld(e), e.shiftKey)}
      onDoubleClick={() => onItemDoubleClick(item.id)}
      onEdit={onEdit}
      onEditTags={onEditTags}
      onMoveToGroup={showMoveToGroup ? (it) => {
        window.dispatchEvent(new CustomEvent("app-move-to-group", { detail: { item: it } }));
      } : undefined}
      onQrCode={onQrCode}
      onRegexPreview={onRegexPreview}
      onManageRegexRules={onManageRegexRules}
      stackOrder={stackOrder}
      stackDone={stackDone}
      index={index}
      disablePreview={disablePreview}
    />
  );
});

