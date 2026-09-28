import type { HistoryItem } from "@/stores/appStore";

/**
 * 队列 chip 的显示文本：优先 `text`，为空时按类型回退
 * （图片/文件条目常常只有 content 路径，没有文本摘要）。
 *
 * StackBanner（悬浮卡预览）与 StackQueue（chip 正文）都要它，
 * 所以放在 `lib/stack/` 里当单一出处 —— 两处各写一份的话，
 * 「悬浮卡显示的内容」和「chip 上显示的内容」会不一致。
 */
export function chipText(it: HistoryItem): string {
  const t = it.text?.trim();
  if (t) return t;
  return it.type === "image" ? "图片" : it.type === "file" ? "文件" : "(空)";
}
