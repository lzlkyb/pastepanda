/**
 * transforms/analyzer.ts — 内容预分析器（Phase 1）。
 *
 * 设计思路（参考 DevToys Smart Detection）：
 * 一次分析 → 多工具消费。所有 transform 的 detect() 不再各自 JSON.parse / 正则 / split，
 * 而是读取这里预计算好的 ContentFeatures，消除重复解析、保证一致性、支持级联检测。
 *
 * 性能约束：整个分析 < 5ms（典型 10KB 文本），通过廉价早退 + 按需深入实现。
 */

import { extractArrayFromJson, type ExtractedArrayInfo } from "@/lib/jsonToolbox";
import { parseColumnList, parseDelimitedValues, type ColumnListInfo } from "./detectors";
import { looksLikePdfText } from "@/lib/docPipeline/pdfRepair";
import { detectColor, type ParsedColor } from "@/lib/color";

// ============ 特征类型 ============

/** JSON 分析结果 */
export interface JsonFeatures {
  /** extractArrayFromJson 的完整结果（顶层数组 or 对象内数组） */
  arrayInfo: ExtractedArrayInfo;
  /** 原始 JSON.parse 是否成功（不论是否为数组） */
  validJson: boolean;
  /** 顶层类型：array / object / scalar / null */
  topType: "array" | "object" | "scalar" | "null" | "invalid";
}

/** Base64 分析结果 */
export interface Base64Features {
  /** 字符合法 + 长度对齐（标准 Base64） */
  valid: boolean;
  /** 解码后的文本（valid=true 时有值） */
  decoded?: string;
  /** 解码后是否看起来像 JSON（级联检测用） */
  decodedIsJson?: boolean;
}

/** URL 编码分析结果 */
export interface UrlEncodedFeatures {
  /** 包含 %XX 模式 */
  hasPattern: boolean;
  /** 解码后的文本 */
  decoded?: string;
  /** 解码后是否看起来像 JWT（级联检测用） */
  decodedIsJwt?: boolean;
}

/** JWT 分析结果 */
export interface JwtFeatures {
  /** 三段式 Base64URL 格式 */
  valid: boolean;
  /** 解码后的 header JSON（valid=true 时有值） */
  header?: string;
  /** 解码后的 payload JSON */
  payload?: string;
}

/** SQL 分析结果 */
export interface SqlFeatures {
  /** 是否看起来像 SQL */
  looksLikeSql: boolean;
  /** 匹配置信度 0~1 */
  confidence: number;
  /** 主语句类型 */
  stmtType?: "select" | "insert" | "update" | "delete" | "create" | "alter" | "drop" | "with";
}

/** 时间戳分析结果 */
export interface TimestampFeatures {
  /** 是否为 10 位（秒）或 13 位（毫秒）纯数字 */
  isTimestamp: boolean;
  /** 类型 */
  kind?: "seconds" | "milliseconds";
  /** 对应日期 ISO 字符串 */
  iso?: string;
}

/** 日期字符串分析结果 */
export interface DateFeatures {
  /** 是否看起来像日期（YYYY-MM-DD 或 YYYY/MM/DD 开头） */
  looksLikeDate: boolean;
}

/** 分隔值分析结果 */
export interface DelimitedFeatures {
  /** 是否命中分隔值模式 */
  ok: boolean;
  /** 值列表 */
  values: string[];
  /** 使用的分隔符 */
  delimiter: string;
  /** 值个数 */
  count: number;
}

/** 日志分析结果 */
export interface LogFeatures {
  /** 是否看起来像日志 */
  looksLikeLog: boolean;
  /** 置信度 */
  confidence: number;
}

/** 配置格式分析结果 */
export interface ConfigFeatures {
  /** 是否看起来像配置（key=value / key: value） */
  looksLikeConfig: boolean;
  /** 置信度 */
  confidence: number;
}

/** 文本统计 */
export interface TextStats {
  /** 行数 */
  lines: number;
  /** 平均行长度 */
  avgLineLen: number;
  /** 是否包含非 ASCII 字符 */
  hasUnicode: boolean;
  /** 是否包含 HTML 标签 */
  hasHtml: boolean;
  /** 首尾是否有空白 */
  hasEdgeWhitespace: boolean;
  /** 是否多行 */
  isMultiline: boolean;
  /** 文本长度 */
  length: number;
  /** 是否为空/纯空白 */
  isEmpty: boolean;
}

/** 完整的内容特征集 */
export interface ContentFeatures {
  /** 原始文本 */
  text: string;
  /** 后端粗分类 */
  contentType: string;
  /** 文本统计（总是计算） */
  stats: TextStats;
  /** JSON 特征（contentType=json 或文本以 { [ " 开头时计算） */
  json?: JsonFeatures;
  /** Base64 特征 */
  base64?: Base64Features;
  /** URL 编码特征 */
  urlEncoded?: UrlEncodedFeatures;
  /** JWT 特征 */
  jwt?: JwtFeatures;
  /** SQL 特征 */
  sql?: SqlFeatures;
  /** 时间戳特征 */
  timestamp?: TimestampFeatures;
  /** 日期字符串特征 */
  date?: DateFeatures;
  /** 按列数据特征 */
  columnList?: ColumnListInfo;
  /** 分隔值特征 */
  delimited?: DelimitedFeatures;
  /** 颜色特征 */
  color?: ParsedColor | null;
  /** 日志特征 */
  log?: LogFeatures;
  /** 配置格式特征 */
  config?: ConfigFeatures;
  /** P2：疑似 PDF 复制文本（多短行 + 行尾非句末标点） */
  pdfLike?: boolean;
  /** P2：疑似 Tab 分隔表格文本（多行 + 多列 Tab） */
  tableLike?: boolean;
}

// ============ 分析逻辑 ============

/** 廉价 Base64 字符集检测（含 Base64URL 的 - _） */
const BASE64_RE = /^[A-Za-z0-9+/=_\-\s]+$/;

/** JWT 三段式 */
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** URL 编码 %XX */
const URL_ENCODED_RE = /%[0-9A-Fa-f]{2}/;

/** HTML 标签 */
const HTML_TAG_RE = /<[a-z][\s\S]*>/i;

/** SQL 主关键字开头 */
const SQL_START_RE = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i;

/** 日志时间戳 */
const LOG_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/m;
const LOG_TS_RE2 = /^\[\d{4}-\d{2}/m;
const LOG_LEVEL_RE = /\b(DEBUG|INFO|WARN|ERROR|FATAL)\b/m;

/** 配置 key=value / key: value */
const CONFIG_KV_RE = /^[^#\s][^=:]*[=:]/;

function decodeB64(s: string): string | null {
  try {
    const cleaned = s.replace(/\s/g, "");
    const binary = atob(cleaned);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function decodeB64Url(s: string): string | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** 快速判断文本是否可能是 JSON（廉价首字符检测） */
function maybeJson(text: string, contentType: string): boolean {
  if (contentType === "json") return true;
  const first = text.trimStart()[0];
  return first === "{" || first === "[" || first === '"';
}

/**
 * 一次性分析文本内容，产出所有 transform 需要的特征。
 * 设计为同步纯函数，典型 10KB 文本 < 5ms。
 */
export function analyzeContent(text: string, contentType: string): ContentFeatures {
  const trimmed = text.trim();
  const lines = text.split(/\r?\n/);
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

  // === 统计（总是计算） ===
  const stats: TextStats = {
    lines: nonEmptyLines.length,
    avgLineLen: nonEmptyLines.length > 0
      ? nonEmptyLines.reduce((s, l) => s + l.length, 0) / nonEmptyLines.length
      : 0,
    // [^\x00-\x7F] 是判"含非 ASCII 字符"的标准写法，\x00 只是 ASCII 区间下界，
    // 不是真要匹配控制字符。no-control-regex 在这里是误报。
    // eslint-disable-next-line no-control-regex
    hasUnicode: /[^\x00-\x7F]/.test(text),
    hasHtml: HTML_TAG_RE.test(text),
    hasEdgeWhitespace: /^\s|\s$/.test(text),
    isMultiline: nonEmptyLines.length > 1,
    length: text.length,
    isEmpty: trimmed.length === 0,
  };

  const features: ContentFeatures = { text, contentType, stats };

  if (stats.isEmpty) return features;

  // === JSON ===
  if (maybeJson(trimmed, contentType)) {
    const arrayInfo = extractArrayFromJson(trimmed);
    let topType: JsonFeatures["topType"] = "invalid";
    let validJson = false;
    try {
      const parsed = JSON.parse(trimmed);
      validJson = true;
      if (Array.isArray(parsed)) topType = "array";
      else if (parsed === null) topType = "null";
      else if (typeof parsed === "object") topType = "object";
      else topType = "scalar";
    } catch { /* invalid */ }
    features.json = { arrayInfo, validJson, topType };
  }

  // === Base64（含 Base64URL） ===
  if (BASE64_RE.test(trimmed) && trimmed.length >= 8) {
    const noWs = trimmed.replace(/\s/g, "");
    // Base64URL → 标准 Base64
    const std = noWs.replace(/-/g, "+").replace(/_/g, "/");
    // 补齐 padding
    const padLen = (4 - (std.length % 4)) % 4;
    const padded = std + "=".repeat(padLen);
    const valid = padded.length % 4 === 0 && std.length >= 8;
    if (valid) {
      const decoded = decodeB64(padded);
      const decodedIsJson = decoded != null && maybeJson(decoded, "");
      features.base64 = { valid: true, decoded: decoded ?? undefined, decodedIsJson };
    } else {
      features.base64 = { valid: false };
    }
  }

  // === URL 编码 ===
  if (URL_ENCODED_RE.test(text)) {
    let decoded: string | undefined;
    let decodedIsJwt: boolean | undefined;
    try {
      decoded = decodeURIComponent(text.replace(/\+/g, " "));
      decodedIsJwt = JWT_RE.test(decoded.trim());
    } catch { /* invalid */ }
    features.urlEncoded = { hasPattern: true, decoded, decodedIsJwt };
  }

  // === JWT ===
  if (JWT_RE.test(trimmed)) {
    const parts = trimmed.split(".");
    const header = decodeB64Url(parts[0]);
    const payload = parts.length > 1 ? decodeB64Url(parts[1]) : null;
    if (header && payload) {
      features.jwt = { valid: true, header, payload };
    } else {
      features.jwt = { valid: false };
    }
  }

  // === SQL ===
  {
    const upper = trimmed.toUpperCase();
    let confidence = 0;
    let stmtType: SqlFeatures["stmtType"];
    const startMatch = upper.match(SQL_START_RE);
    if (startMatch) {
      confidence = 0.9;
      stmtType = startMatch[1].toLowerCase() as SqlFeatures["stmtType"];
    } else if (/\bFROM\b/.test(upper) && /\bWHERE\b/.test(upper)) {
      confidence = 0.7;
    } else if (contentType === "code" && /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(upper)) {
      confidence = 0.6;
    } else if (/\bIN\s*\(/.test(upper) || /\bVALUES\s*\(/.test(upper) || /\bJOIN\b/.test(upper)) {
      confidence = 0.5;
    }
    if (confidence > 0) {
      features.sql = { looksLikeSql: true, confidence, stmtType };
    }
  }

  // === 时间戳 ===
  if (/^\d{10}$/.test(trimmed)) {
    const d = new Date(parseInt(trimmed, 10) * 1000);
    features.timestamp = { isTimestamp: true, kind: "seconds", iso: d.toISOString() };
  } else if (/^\d{13}$/.test(trimmed)) {
    const d = new Date(parseInt(trimmed, 10));
    features.timestamp = { isTimestamp: true, kind: "milliseconds", iso: d.toISOString() };
  }

  // === 日期字符串 ===
  if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(trimmed)) {
    features.date = { looksLikeDate: true };
  }

  // === 按列数据 ===
  {
    const colInfo = parseColumnList(text);
    if (colInfo.ok) {
      features.columnList = colInfo;
    }
  }

  // === 分隔值 ===
  // 解析统一走 detectors.parseDelimitedValues（含外层括号剥除），
  // 不在这里留第二份副本；外层 gate 仅作廉价早退，避开对大文本的无谓调用。
  if (!stats.isMultiline || stats.lines <= 3) {
    const delimInfo = parseDelimitedValues(text);
    if (delimInfo.ok) features.delimited = delimInfo;
  }

  // === 颜色 ===
  if (contentType === "color" || /^#?[0-9a-fA-F]{3,8}$/.test(trimmed) || /^(rgb|hsl)a?\(/i.test(trimmed)) {
    features.color = detectColor(trimmed);
  }

  // === 日志 ===
  {
    const hasTs = LOG_TS_RE.test(text) || LOG_TS_RE2.test(text);
    const hasLevel = LOG_LEVEL_RE.test(text);
    let confidence = 0;
    if (contentType === "log") confidence = 0.95;
    else if (hasTs && hasLevel) confidence = 0.85;
    else if (hasLevel && stats.lines > 10) confidence = 0.5;
    if (confidence > 0) {
      features.log = { looksLikeLog: true, confidence };
    }
  }

  // === 配置格式 ===
  {
    let confidence = 0;
    if (contentType === "config") {
      confidence = 0.9;
    } else {
      const sampleLines = nonEmptyLines.slice(0, 10);
      const kvCount = sampleLines.filter((l) => CONFIG_KV_RE.test(l.trim())).length;
      if (kvCount >= 2) confidence = 0.5;
    }
    if (confidence > 0) {
      features.config = { looksLikeConfig: true, confidence };
    }
  }

  // === P2：疑似 PDF 复制文本（多短行 + 行尾非句末标点） ===
  // pdfRepair 模块不依赖 transforms，静态 import 无循环依赖
  // 不做 avgLineLen 预筛——looksLikePdfText 内部已判 ≥60% 行短，外层门控会漏检混入长行的 PDF
  if (stats.lines >= 5) {
    features.pdfLike = looksLikePdfText(text);
  }

  // === P2：疑似 Tab 分隔表格（多行 + ≥2 列 Tab） ===
  if (stats.lines >= 2) {
    const tabCols = nonEmptyLines.map((l) => (l.match(/\t/g) || []).length + 1);
    const multiCol = tabCols.filter((c) => c >= 2).length;
    features.tableLike = multiCol / nonEmptyLines.length >= 0.6;
  }

  return features;
}
