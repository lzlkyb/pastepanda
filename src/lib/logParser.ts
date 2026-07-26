/**
 * logParser.ts — 日志解析纯逻辑（全屏 LogPreview 用）。
 * 与 Rust 分类器（content_classifier.rs LOG_TS_RE / LOG_LEVEL_RE）同源：
 * 5 种行首时间戳格式 + 8 种级别关键词；无时间戳前缀的行视为上一条的续行（堆栈）。
 * 纯函数无副作用，便于单元测试。
 */

/** 归一化后的日志级别（WARNING→WARN，NOTICE→INFO，CRITICAL→FATAL） */
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/** 级别显示顺序（过滤芯片按此排列） */
export const LEVEL_ORDER: LogLevel[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

/** 行首时间戳（与 Rust LOG_TS_RE 同源的 5 种格式） */
const TS_RES: RegExp[] = [
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/,        // 2026-07-25 21:03:12(.123)
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\]/,                    // [2026-07-25T21:03:12]
  /^\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/,                           // 07/25 21:03:12
  /^\[\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}/,            // [25/Jul/2026:21:03:12（nginx）
  /^[A-Z][a-z]{2}\s{1,2}\d{1,2}\s+\d{2}:\d{2}:\d{2}/,            // Jul 25 21:03:12（syslog）
];

const LEVEL_RE = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE|NOTICE|CRITICAL)\b/i;

/** 级别归一化：WARNING→WARN / NOTICE→INFO / CRITICAL→FATAL */
function normalizeLevel(raw: string): LogLevel {
  const up = raw.toUpperCase();
  if (up === "WARNING") return "WARN";
  if (up === "NOTICE") return "INFO";
  if (up === "CRITICAL") return "FATAL";
  return up as LogLevel;
}

/** 提取行首时间戳文本（去掉包裹括号，T 分隔符归一为空格）；无则 null */
function matchTimestamp(line: string): { time: string; rest: string } | null {
  for (const re of TS_RES) {
    const m = re.exec(line);
    if (m) {
      const raw = m[0];
      const time = raw.replace(/^\[|\]$/g, "").replace("T", " ");
      // nginx 时间戳正则止于秒，行首可能残留时区片段（" +0800]"），先剥离再清空白/括号
      return { time, rest: line.slice(raw.length).replace(/^(?:\s*[+-]\d{4})?[\s\]]+/, "") };
    }
  }
  return null;
}

export interface LogEntry {
  /** 行首时间戳（归一化后；无则 null） */
  time: string | null;
  /** 级别（归一化后；无则 null） */
  level: LogLevel | null;
  /** 主消息（去时间戳后的首行） */
  msg: string;
  /** 续行（堆栈等无时间戳前缀的后续行） */
  cont: string[];
}

export interface LogParseResult {
  entries: LogEntry[];
  /** 各级别计数（仅含有级别的条目） */
  counts: Partial<Record<LogLevel, number>>;
  /** 原始总行数 */
  totalLines: number;
}

/** 解析日志全文为条目列表（续行归属上一条） */
export function parseLog(text: string): LogParseResult {
  const lines = text.split(/\r?\n/);
  const entries: LogEntry[] = [];
  const counts: Partial<Record<LogLevel, number>> = {};

  for (const line of lines) {
    if (!line.trim()) continue;
    const ts = matchTimestamp(line);
    if (!ts && entries.length > 0) {
      // 无时间戳前缀 → 上一条的续行（堆栈/多行消息）
      entries[entries.length - 1].cont.push(line);
      continue;
    }
    const body = ts ? ts.rest : line;
    const lm = LEVEL_RE.exec(body);
    const level = lm ? normalizeLevel(lm[1]) : null;
    if (level) counts[level] = (counts[level] ?? 0) + 1;
    entries.push({ time: ts?.time ?? null, level, msg: body.trim(), cont: [] });
  }

  return { entries, counts, totalLines: lines.length };
}

/**
 * 过滤条目：
 * - levels 为 null = 全部；否则仅保留集合内级别（无级别条目在过滤态下隐藏）
 * - keyword 大小写不敏感，匹配 消息 / 续行 / 时间戳
 */
export function filterEntries(
  entries: LogEntry[],
  levels: Set<LogLevel> | null,
  keyword: string
): LogEntry[] {
  const kw = keyword.trim().toLowerCase();
  return entries.filter((e) => {
    if (levels && !levels.has(e.level ?? ("__none__" as LogLevel))) return false;
    if (!kw) return true;
    if (e.time && e.time.toLowerCase().includes(kw)) return true;
    if (e.msg.toLowerCase().includes(kw)) return true;
    return e.cont.some((c) => c.toLowerCase().includes(kw));
  });
}
