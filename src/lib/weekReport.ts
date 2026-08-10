/**
 * lib/weekReport.ts —— v6.4 E 剪贴板周报：行为侧写统计 → 展示/LLM 输入。
 * 纯函数，供 WeekReportDialog 与测试共用。**只含数字，不含任何内容**（守红线）。
 */

export interface WeekStats {
  total: number;
  textCount: number;
  imageCount: number;
  fileCount: number;
  hours: number[]; // 24 槽
  sources: { source: string; count: number }[];
}

/** 冷启动阈值：总记录太少时周报没意义 */
export const WEEK_REPORT_MIN_EVENTS = 50;

/** 24 槽时段 → 三档分布（工作 9-17 / 晚间 18-23 / 深夜 0-8，与场景感知同口径） */
export function hourBuckets(hours: number[]): { work: number; evening: number; night: number } {
  let work = 0;
  let evening = 0;
  let night = 0;
  hours.forEach((c, h) => {
    if (h >= 9 && h <= 17) work += c;
    else if (h >= 18 && h <= 23) evening += c;
    else night += c;
  });
  return { work, evening, night };
}

/** 把统计拼成给 LLM 的文本（只含数字与分类名，无内容） */
export function statsToText(
  s: WeekStats,
  pasted: number,
  topActions: { actionId: string; count: number }[],
): string {
  const buckets = hourBuckets(s.hours);
  const rate = s.total > 0 ? Math.round((pasted / s.total) * 100) : 0;
  return [
    `近 7 天共复制 ${s.total} 次，其中 ${pasted} 次真正粘贴使用，粘贴转化率 ${rate}%。`,
    `内容类型：文本 ${s.textCount}、图片 ${s.imageCount}、文件 ${s.fileCount}。`,
    `常用来源：${s.sources.map((x) => `${x.source}(${x.count})`).join("、") || "暂无"}。`,
    `活跃时段：工作时间 ${buckets.work}、晚间 ${buckets.evening}、深夜 ${buckets.night}。`,
    `常用变换动作：${topActions.map((a) => `${a.actionId}(${a.count})`).join("、") || "暂无"}。`,
  ].join("\n");
}
