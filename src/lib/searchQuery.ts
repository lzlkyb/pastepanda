/**
 * lib/searchQuery.ts —— v6.4 D 搜索阶段 2：自然语言查询解析（本地，零 AI 成本）。
 *
 * 把「上周复制的那个 API 文档」「今天的内容」这类句子解析出时间过滤条件。
 *
 * 设计取舍（克制优先）：
 * - **只认句首时间词**：避免「今天天气」这种词内粘连的普遍误判（"今天天气"不会
 *   因为开头有"今天"就丢掉关键词——关键词永远原样保留）；
 * - **关键词绝不丢弃**：解析只额外设置 timeFilter 做**双保险**，原文照常进入搜索
 *   （FTS 对"上周"这类词本身也能命中），误判代价仅为范围收窄，可一键改回；
 * - 不调 AI、不上云：纯本地正则，符合「本地规则能解决的绝不上云」。
 */
import type { TimeFilter } from "@/stores/appStore";

export interface ParsedSearch {
  /** 原样保留的关键词（不因解析而丢失任何字） */
  keyword: string;
  /** 解析出的时间过滤；未识别为 "all" */
  timeFilter: TimeFilter;
}

/** 句首时间词 → 现有时间过滤（与前端 today/week/month 语义一致） */
const TIME_PREFIX: [RegExp, TimeFilter][] = [
  [/^(今天|今日)/, "today"],
  [/^(上周|上一周|上个星期)/, "week"],
  [/^(这周|本周|这一周|这个星期)/, "week"],
  [/^(上个月|上一个月)/, "month"],
  [/^(这个月|本月)/, "month"],
];

/** 解析自然语言查询（时间词只认句首；关键词原样返回） */
export function parseSearchQuery(input: string): ParsedSearch {
  const t = input.trim();
  for (const [re, tf] of TIME_PREFIX) {
    if (re.test(t)) {
      return { keyword: t, timeFilter: tf };
    }
  }
  return { keyword: t, timeFilter: "all" };
}
