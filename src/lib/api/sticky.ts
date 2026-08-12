/**
 * 粘性数据 API（v6.8）：活跃日历 / 连续周数 / 成就 / 里程碑原料。
 *
 * 与后端 `stats_sticky` 一一对应：纯本地只读聚合，**不含任何内容**。
 * 前端拿到的只有日期、次数、布尔、条数——画日历、判成就、触发里程碑
 * 都在本地完成，不外发。
 */
import { invoke } from "@tauri-apps/api/core";

/** 活跃日历的一天（date = "YYYY-MM-DD"，count = 当天事件数） */
export interface CalendarDay {
  date: string;
  count: number;
}

export interface StickyStats {
  /** 最近 12 周（84 天）逐日活跃，从 83 天前到今天升序 */
  calendar: CalendarDay[];
  /** 连续活跃周数（截至本周；本周无记录则为 0） */
  activeWeekStreak: number;
  /** 84 天内有事件的天数 */
  activeDays: number;
  /** history 现存条目数 */
  historyCount: number;
  /** 最早一条复制的本地时间（"使用开始日"，安装周年里程碑用） */
  firstHistoryAt: string | null;
  /** 自定义链条数 */
  customChainCount: number;
  /** 用过 AI */
  aiUsed: boolean;
  /** 用过生成工具（ai-regex-generate / ai-sql-generate） */
  toolUsed: boolean;
  /** 跑过排错流水线 */
  triageUsed: boolean;
  /** 导出过画像 */
  profileExported: boolean;
  /** 画像做过 AI 精炼 */
  profileRefined: boolean;
}

/** 拉取粘性数据总览（本地只读） */
export async function statsSticky(): Promise<StickyStats> {
  return invoke("stats_sticky");
}
