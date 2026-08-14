/**
 * lib/mergeText.ts —— v6.4 C 连续合并粘贴：多段文本按分隔方式合并。
 * 纯函数，供 MergeDialog 与测试共用。
 */

import type { HistoryItem } from "@/stores/appStore";

export type MergeSeparator =
  | "newline"
  | "comma"
  | "semicolon"
  | "numbered"
  | "custom"
  | "markdown"
  | "smart";

/** "智能换行"的“短段”判定：单行且不超过 40 字才算短，否则视为长段落单独成段 */
function isShortSegment(s: string): boolean {
  return s.length <= 40 && !s.includes("\n");
}

/** 合并多段文本（自动过滤空段） */
export function mergeTexts(
  texts: string[],
  sep: MergeSeparator,
  customSep = "、",
): string {
  const t = texts.map((x) => x.trim()).filter(Boolean);
  switch (sep) {
    case "newline":
      return t.join("\n");
    case "comma":
      return t.join(", ");
    case "semicolon":
      return t.join("；");
    case "numbered":
      return t.map((x, i) => `${i + 1}. ${x}`).join("\n");
    case "custom":
      return t.join(customSep);
    case "markdown":
      // 只在首行加 "- "，多行段落的其余行保持原样，避免把每一行都变成列表项
      return t.map((x) => `- ${x}`).join("\n");
    case "smart": {
      // 连续短段落用单换行连接；只要一侧是长段落就用空行隔开，让长段在视觉上独立成段
      let out = "";
      for (let i = 0; i < t.length; i++) {
        if (i === 0) { out = t[i]; continue; }
        const bothShort = isShortSegment(t[i - 1]) && isShortSegment(t[i]);
        out += (bothShort ? "\n" : "\n\n") + t[i];
      }
      return out;
    }
  }
}

/** 拖拽栈条目 → MergeDialog 需要的 {id,text}[]：图片/文件条目的 text 本身已经是人可读标签（见 StackBanner 的
 *  chipText 同样的回退逻辑），直接复用即可，无需再写一份类型判断；text 为空时才回退到占位。 */
export function stackItemsToMergeItems(items: HistoryItem[]): { id: string; text: string }[] {
  return items.map((it) => {
    const t = it.text?.trim();
    if (t) return { id: it.id, text: t };
    const placeholder = it.type === "image" ? "[图片]" : it.type === "file" ? "[文件]" : "(空)";
    return { id: it.id, text: placeholder };
  });
}
