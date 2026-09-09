/**
 * 待沉淀「入选原因」的**唯一**展示表。
 *
 * 后端 `kb_inbox.rs::reason_expr()` 只回原始值（`star`/`research`/`recopy`/`shot`），
 * 中文名与图标只住在这里——与 `CONTENT_TYPE_META` 同一个约定：
 * Rust 里不再写一份中文表（规则 #11）。
 *
 * 🔴 为什么单开一个文件而不是放在面板里：这张表有**四个**消费者——
 * 征标、组头、筛选按钮（`KbInboxPanel`）与已选条件条（`viewOpts`）。
 * 旧实现在这四处各写了一遍 `reason === "star" ? "收藏" : "找回"`，
 * 于是加两条通路后四处全会把重复复制与截图误报成「找回」——
 * 而那**不报错**，只是界面上静默地说错话。
 */
import { Star, Search, Repeat } from "lucide-react";
import type { InboxReason } from "@/lib/api";

export const REASON_META: Record<
  InboxReason,
  {
    /** 征标与组头上的短名 */
    label: string;
    /** 已选条件条上的长名（「只看……」）*/
    only: string;
    Icon: typeof Star;
    /** `KbInboxPanel.module.css` 里的类名 */
    badge: string;
  }
> = {
  star: { label: "收藏", only: "只看收藏", Icon: Star, badge: "badgeStar" },
  research: { label: "找回", only: "只看找回", Icon: Search, badge: "badgeHit" },
  recopy: { label: "重复用", only: "只看重复用的", Icon: Repeat, badge: "badgeRecopy" },
};

/** 按优先级排好的全部原因。顺序与后端 `reason_expr()` 的 `WHEN` 一致。 */
export const REASON_ORDER: InboxReason[] = ["star", "research", "recopy"];
