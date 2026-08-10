/**
 * lib/mergeText.ts —— v6.4 C 连续合并粘贴：多段文本按分隔方式合并。
 * 纯函数，供 MergeDialog 与测试共用。
 */

export type MergeSeparator = "newline" | "comma" | "semicolon" | "numbered" | "custom";

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
  }
}
