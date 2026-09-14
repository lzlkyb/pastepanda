/**
 * toolEditors.ts — 从「工具」模式打开内容型编辑器（不依赖历史条目）。
 *
 * 剪贴板文本 → 合成 HistoryItem（id 前缀 `tool-`）→ dialogStore.openEditor。
 * `useEditorCore` 对 `tool-` 前缀的保存走「写回剪贴板」而不是 update_history
 * （库里没有这条 id）。
 */
import type { HistoryItem } from "@/stores/appStore";
import { readClipboardText } from "@/lib/api";

export { readClipboardText };

/** 工具合成条目的 id 前缀（useEditorCore 保存分支据此判定） */
export const TOOL_ITEM_PREFIX = "tool-";

export function isToolItemId(id: string | undefined): boolean {
  return !!id && id.startsWith(TOOL_ITEM_PREFIX);
}

/** 合成一条仅用于打开编辑器的伪历史条目 */
export function makeToolItem(
  contentType: NonNullable<HistoryItem["content_type"]>,
  text: string,
): HistoryItem {
  return {
    id: `${TOOL_ITEM_PREFIX}${contentType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    time: "",
    type: "text",
    content: "",
    pinned: false,
    source: "工具",
    workspace: "",
    content_type: contentType,
  };
}

/** 读剪贴板 → 按 content_type 打开对应编辑器 */
export async function openClipboardTool(
  contentType: NonNullable<HistoryItem["content_type"]>,
): Promise<void> {
  const { useDialogStore } = await import("@/stores/dialogStore");
  const text = await readClipboardText();
  useDialogStore.getState().openEditor(makeToolItem(contentType, text));
}
