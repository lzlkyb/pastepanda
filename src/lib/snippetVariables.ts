/**
 * snippetVariables.ts — 代码片段变量解析。
 *
 * 支持在片段内容中使用 {{变量名}} 占位符，复制时自动替换为实际值。
 * 同步变量直接替换；异步变量（如 {{clipboard}}）需要 await。
 *
 * 支持的变量：
 *  {{date}}      → 2026-07-28
 *  {{time}}      → 14:30:00
 *  {{datetime}}  → 2026-07-28 14:30:00
 *  {{year}}      → 2026
 *  {{month}}     → 07
 *  {{day}}       → 28
 *  {{timestamp}} → 1753689000（Unix 秒）
 *  {{uuid}}      → 随机 UUID
 *  {{clipboard}} → 当前剪贴板内容（异步）
 */

// 直接引 api/paste 而不是 @/lib/api 桶文件：lib 层引桶容易绕出循环依赖。
import { readClipboardText } from "@/lib/api/paste";

/** 所有支持的变量名（用于 UI 提示/文档） */
export const SNIPPET_VARIABLES = [
  { name: "date", label: "日期", example: "2026-07-28" },
  { name: "time", label: "时间", example: "14:30:00" },
  { name: "datetime", label: "日期时间", example: "2026-07-28 14:30:00" },
  { name: "year", label: "年", example: "2026" },
  { name: "month", label: "月", example: "07" },
  { name: "day", label: "日", example: "28" },
  { name: "timestamp", label: "时间戳", example: "1753689000" },
  { name: "uuid", label: "UUID", example: "a1b2c3d4-..." },
  { name: "clipboard", label: "剪贴板", example: "(当前内容)" },
] as const;

/** 检测内容是否包含变量占位符 */
export function hasVariables(content: string): boolean {
  return /\{\{[a-z]+\}\}/.test(content);
}

/** 同步解析变量（不含 clipboard） */
function resolveSync(name: string): string | null {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  switch (name) {
    case "date":
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    case "time":
      return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    case "datetime":
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    case "year":
      return String(now.getFullYear());
    case "month":
      return pad(now.getMonth() + 1);
    case "day":
      return pad(now.getDate());
    case "timestamp":
      return String(Math.floor(now.getTime() / 1000));
    case "uuid":
      return crypto.randomUUID();
    default:
      return null;
  }
}

/**
 * 解析片段中的所有变量占位符。
 * 异步：如果包含 {{clipboard}}，需要 await 读取剪贴板。
 */
export async function resolveSnippetVariables(content: string): Promise<string> {
  if (!hasVariables(content)) return content;

  // 先处理异步变量 {{clipboard}}
  let result = content;
  if (result.includes("{{clipboard}}")) {
    // `readClipboardText` 自带兜底（读不到返回空串），不用再包 try。
    // 不用 `navigator.clipboard.readText()`：它会弹浏览器权限框。
    const clipText = await readClipboardText();
    result = result.replace(/\{\{clipboard\}\}/g, clipText);
  }

  // 再处理同步变量
  result = result.replace(/\{\{([a-z]+)\}\}/g, (match, name: string) => {
    const val = resolveSync(name);
    return val !== null ? val : match; // 未知变量保留原文
  });

  return result;
}
