/**
 * lib/dailyBrief.ts —— 每日整理的纯函数（文案与 AI 输入）。
 *
 * 与 `lib/events.ts` 分开：那边是「怎么分段」（与事件聚合 G3 共用），
 * 这边是「分完之后怎么写成话」（只有每日整理用）。
 */
import type { Segment } from "@/lib/events";

/**
 * 剪贴板主类型的中文名。
 *
 * 与 `contentTypeLabel` 互补：后者管的是 `content_type`（json / markdown / sql …），
 * 而这里管的是 `type` 列那四个值。拿不到时回退到 `contentTypeLabel`，
 * 再拿不到就原值——**宁可显示英文 id 也不编中文**。
 */
export const TYPE_LABELS: Record<string, string> = {
  text: "文本",
  image: "图片",
  file: "文件",
  doc: "文档",
  rich: "富文本",
  diagram: "流程图",
};

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** `"2026-09-04"` → `"9 月 4 日 · 周五"`。不补零（中文不写「09 月 04 日」）。 */
export function dayTitle(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m} 月 ${d} 日 · ${WEEK[dt.getDay()]}`;
}

/** 一段的时间标签：单条段只写一个时间点。 */
function segTime(s: Segment): string {
  return s.startTime === s.endTime ? s.startTime : `${s.startTime}-${s.endTime}`;
}

/**
 * 把一天的分段与类型分布拼成给 LLM 的文本。
 *
 * # 🔴 只允许出现两类东西：**数字**与**已归一化的来源名**
 *
 * 它是整个每日整理里唯一会把数据送出网的地方。
 * 绝不得拼入：条目 `id`、`text`、`content`、原始 `source`（完整窗口标题
 * 里可能带文件名与页面标题，如「工资表 2026年度机密.xlsx - Excel」）。
 * 传进来的 `Segment.topSource` 已经过 `cleanSourceName` 取了最后一段。
 * 已配单测钉住这几条。
 *
 * 内容层（授权后读原文）是下一期 C3，**不得在这里开口子**。
 *
 * @param typeBars `[类型, 条数][]`，已按条数降序。
 */
export function briefToText(
  date: string,
  segments: Segment[],
  typeBars: [string, number][],
): string {
  const total = typeBars.reduce((a, [, n]) => a + n, 0);
  const lines: string[] = [
    `日期：${dayTitle(date)}。全天共复制 ${total} 条，分成 ${segments.length} 段。`,
  ];

  if (typeBars.length > 0) {
    lines.push(
      `内容类型：${typeBars
        .map(([t, n]) => `${TYPE_LABELS[t] ?? t} ${n} 条`)
        .join("、")}。`,
    );
  }

  if (segments.length > 0) {
    lines.push("各段：");
    for (const s of segments) {
      const types = s.typeCounts
        .map((t) => `${TYPE_LABELS[t.type] ?? t.type} ${t.count}`)
        .join("、");
      lines.push(`- ${segTime(s)} 主要在 ${s.topSource}，${s.items.length} 条（${types}）`);
    }
  }

  return lines.join("\n");
}
