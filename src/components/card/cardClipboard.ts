import { HistoryItem } from "@/stores/appStore";
import { getImageOcrFullText, getImageBarcodes, joinBarcodeTexts, copyToClipboard, type ImageOcrState, type ImageBarcodeState } from "@/lib/utils";

/**
 * 复制图片的 OCR 识别文字（收口函数，规则 #11）。
 * Popover「复制文字」按钮与右键「复制识别文字」项共用：
 * 完整文本获取（getImageOcrFullText，非截断）+ 写入剪贴板（copyToClipboard 收口版）
 * + toast 文案只写一份。无文字时静默返回（入口本就不该出现）。
 */
export async function copyOcrTextToClipboard(
  item: HistoryItem,
  ocrState: ImageOcrState | undefined,
  toast: (message: string, type?: "success" | "error") => void,
): Promise<void> {
  const text = getImageOcrFullText(item, ocrState);
  if (!text) return;
  const ok = await copyToClipboard(text);
  toast(ok ? "已复制识别文字" : "复制失败", ok ? "success" : "error");
}

/**
 * 复制图片解码出的二维码/条码内容（收口函数，规则 #11，与 copyOcrTextToClipboard 同构）。
 * 右键「复制二维码/条码内容」与预览抽屉「复制全部」共用同一份取数与拼接逻辑；
 * 多码按行拼接。无码时静默返回（入口本就不该出现）。
 */
export async function copyBarcodesToClipboard(
  item: HistoryItem,
  barcodeState: ImageBarcodeState | undefined,
  toast: (message: string, type?: "success" | "error") => void,
): Promise<void> {
  const hits = getImageBarcodes(item, barcodeState);
  if (!hits || hits.length === 0) return;
  const ok = await copyToClipboard(joinBarcodeTexts(hits));
  toast(ok ? "已复制二维码/条码内容" : "复制失败", ok ? "success" : "error");
}
