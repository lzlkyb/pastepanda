/**
 * transforms/logTransforms.ts — 日志统计变换。
 *
 * 复用 logParser.ts 的 parseLog，输出级别分布 + 时间范围 + 高频错误摘要。
 */

import { parseLog, LEVEL_ORDER, type LogLevel } from "@/lib/logParser";
import type { Transform, TransformContext, TransformResult } from "./types";

function ok(output: string, meta?: { count?: number }): TransformResult {
  return { ok: true, output, ...(meta ? { meta } : {}) };
}

function fail(message: string): TransformResult {
  return { ok: false, message };
}

/** 检测文本是否像日志 */
function looksLikeLog(ctx: TransformContext): number {
  if (ctx.contentType === "log") return 0.95;
  const t = ctx.text;
  // 多行 + 包含时间戳模式 + 级别关键字
  const lines = t.split("\n");
  if (lines.length < 3) return 0;
  const hasTs = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/m.test(t) || /^\[\d{4}-\d{2}/m.test(t);
  const hasLevel = /\b(DEBUG|INFO|WARN|ERROR|FATAL)\b/m.test(t);
  if (hasTs && hasLevel) return 0.85;
  if (hasLevel && lines.length > 10) return 0.5;
  return 0;
}

/** 级别柱状图（文本版） */
function levelBar(count: number, max: number): string {
  if (max === 0) return "";
  const barLen = Math.round((count / max) * 20);
  return "█".repeat(Math.max(barLen, count > 0 ? 1 : 0));
}

const logStats: Transform = {
  id: "log_stats",
  label: "日志统计",
  description: "级别分布 + 时间范围 + 高频错误摘要",
  icon: "bar-chart",
  group: "log",
  detect: looksLikeLog,
  run: (t) => {
    if (!t.trim()) return fail("空文本");

    const { entries, counts, totalLines } = parseLog(t);
    if (entries.length === 0) return fail("未识别到日志条目");

    // 时间范围
    const times = entries.filter((e) => e.time).map((e) => e.time!);
    const timeRange = times.length > 0
      ? `${times[0]} → ${times[times.length - 1]}`
      : "无时间戳";

    // 级别分布
    const maxCount = Math.max(...LEVEL_ORDER.map((l) => counts[l] ?? 0), 1);
    const levelLines = LEVEL_ORDER
      .filter((l) => (counts[l] ?? 0) > 0)
      .map((l) => {
        const c = counts[l] ?? 0;
        const pct = ((c / entries.length) * 100).toFixed(1);
        return `  ${l.padEnd(6)} ${String(c).padStart(5)}  ${levelBar(c, maxCount)} ${pct}%`;
      });

    // 高频错误消息（ERROR/FATAL 的 msg 去重取 top 5）
    const errorEntries = entries.filter(
      (e) => e.level === "ERROR" || e.level === "FATAL"
    );
    const errorFreq = new Map<string, number>();
    for (const e of errorEntries) {
      // 截取前 80 字符作为 key（去掉数字差异）
      const key = e.msg.replace(/\d+/g, "N").slice(0, 80);
      errorFreq.set(key, (errorFreq.get(key) ?? 0) + 1);
    }
    const topErrors = [...errorFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([msg, cnt]) => `  [${cnt}x] ${msg}`);

    // 组装报告
    const parts: string[] = [
      `═══ 日志统计 ═══`,
      `总行数: ${totalLines}  条目数: ${entries.length}`,
      `时间范围: ${timeRange}`,
      ``,
      `── 级别分布 ──`,
      ...levelLines,
    ];

    if (topErrors.length > 0) {
      parts.push(``, `── 高频错误 Top ${topErrors.length} ──`, ...topErrors);
    }

    const errorTotal = (counts.ERROR ?? 0) + (counts.FATAL ?? 0);
    const warnTotal = counts.WARN ?? 0;
    parts.push(``, `摘要: ${errorTotal} 错误 / ${warnTotal} 警告 / ${entries.length} 条`);

    return ok(parts.join("\n"), { count: entries.length });
  },
};

/** 提取所有 ERROR/FATAL 行（快速定位错误） */
const logErrors: Transform = {
  id: "log_errors",
  label: "提取错误行",
  description: "仅保留 ERROR 和 FATAL 级别的日志条目",
  icon: "alert-triangle",
  group: "log",
  detect: looksLikeLog,
  run: (t) => {
    if (!t.trim()) return fail("空文本");
    const { entries } = parseLog(t);
    const errors = entries.filter((e) => e.level === "ERROR" || e.level === "FATAL");
    if (errors.length === 0) return fail("未发现 ERROR/FATAL 条目");

    const lines = errors.map((e) => {
      const prefix = e.time ? `${e.time} ` : "";
      const cont = e.cont.length > 0 ? "\n" + e.cont.join("\n") : "";
      return `${prefix}${e.msg}${cont}`;
    });

    return ok(lines.join("\n\n"), { count: errors.length });
  },
};

export const logTransforms: Transform[] = [logStats, logErrors];
