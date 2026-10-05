import { DEFAULT_QUALITY } from "@/lib/rcQuality";

/**
 * 手机端（被控 = 编码端）画质可选档，顺序 = 界面呈现顺序。
 *
 * 🔴 2026-10-02 真机修复：这张表原先只有三档（清晰/均衡/流畅），且 `RcMobileSession`
 *    的回落值硬编码 `"balanced"`。后端默认档（`DEFAULT_QUALITY`）是 `auto`（自动
 *    换档），于是手机把「自动」显示成「均衡」——**显示与实际跑的策略不一致**。
 *    未知/缺失的 hint 一律回落默认档，不再猜 balanced。
 *
 * 中文名与桌面同源：`@/lib/rcQuality` 的 `qualityLabel`（规则 11，不抄第三遍）。
 */
export type MobileQuality = "auto" | "sharp" | "balanced" | "smooth";

export const MOBILE_QUALITY_CYCLE: readonly MobileQuality[] = [
  "auto",
  "sharp",
  "balanced",
  "smooth",
];

function isMobileQuality(q: string | undefined | null): q is MobileQuality {
  return q === "auto" || q === "sharp" || q === "balanced" || q === "smooth";
}

/** 默认档也必须是可选项：表里没有默认档 = 状态永远显示不出真实策略。 */
export function defaultMobileQuality(): MobileQuality {
  return isMobileQuality(DEFAULT_QUALITY) ? DEFAULT_QUALITY : "auto";
}

/** 把后端 `status.quality`（或任何外来字符串）收敛成手机可选档。 */
export function normalizeMobileQuality(hint: string | undefined | null): MobileQuality {
  return isMobileQuality(hint) ? hint : defaultMobileQuality();
}
