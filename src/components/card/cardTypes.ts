import type { HistoryItem } from "@/stores/appStore";
import type { ImageOcrState, ImageBarcodeState } from "@/lib/utils";
import type { MenuItem } from "@/components/ContextMenu";

export type ImgState = { status: "loading" | "loaded" | "error" | "silent"; url?: string };
export interface CardProps {
  item: HistoryItem;
  selected: boolean;
  current?: boolean;
  checked?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  index: number;
  imageState?: ImgState;
  searchKeyword?: string;
  onRetryImage?: () => void;
  pasting?: boolean;
  menuItems?: MenuItem[];
  onEdit?: (item: HistoryItem) => void;
  disablePreview?: boolean;
  stackOrder?: number;
  stackDone?: boolean;
  ocrState?: ImageOcrState;
  barcodeState?: ImageBarcodeState;
}
export interface CardContextProps {
  item: HistoryItem;
  selected: boolean;
  current?: boolean;
  checked?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  index: number;
  imageState?: ImgState;
  searchKeyword?: string;
  onRetryImage?: () => void;
  pasting?: boolean;
  onEdit?: (item: HistoryItem) => void;
  onEditTags?: (item: HistoryItem) => void;
  onMoveToGroup?: (item: HistoryItem) => void;
  onQrCode?: (item: HistoryItem) => void;
  onRegexPreview?: (item: HistoryItem, ruleId: string) => void;
  onManageRegexRules?: () => void;
  disablePreview?: boolean;
  stackOrder?: number;
  stackDone?: boolean;
  ocrState?: ImageOcrState;
  barcodeState?: ImageBarcodeState;
}
