/**
 * lib/pasteGuard.ts —— 粘贴守卫（v6.2 粘贴前主动；审查 #8 下沉到 api/paste 后此为薄封装）。
 *
 * 守卫核心已收口到 `lib/api/paste.ts` 的 `pasteTextGuarded/pasteRichGuarded`，
 * 所有用户触发的粘贴（卡片/托盘/快捷区/链/序列/编辑器…）自动继承；
 * 此处保留 `pasteGuarded` 供既有调用方（Card.tsx）与 `targetAppLabel` 向后兼容。
 */

import { pasteTextGuarded } from "@/lib/api/paste";

/** 目标应用可读名（向后兼容导出，守卫内部已用 api 层版本） */
export function targetAppLabel(category: string | null, app: string | null): string | null {
  if (app) return app;
  if (!category) return null;
  const map: Record<string, string> = {
    browser: "浏览器",
    excel: "Excel",
    word: "Word",
    office: "WPS 办公",
    ide: "代码编辑器",
    terminal: "终端",
    other: "其他应用",
  };
  return map[category] ?? null;
}

/**
 * 带守卫的粘贴：敏感内容先确认，再执行。
 * 返回是否真的执行了粘贴（取消/失败 = false）。
 *
 * - 内容不敏感 → 直接粘贴（不打断，零额外开销的查询仅目标感知）
 * - 内容敏感 → 弹确认条：[脱敏后粘贴] / [原样粘贴] / [取消]
 */
export async function pasteGuarded(text: string): Promise<boolean> {
  return pasteTextGuarded(text);
}
