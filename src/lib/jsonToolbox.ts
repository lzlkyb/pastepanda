/**
 * JSON 数组 → SQL IN 工具箱（纯函数层）。
 *
 * 仿 numberToolbox.ts 的组织方式：全部为无副作用纯函数，便于单元测试。
 * UI（JsonEditor 智能结果条 / 卡片右键"复制为 SQL IN"）只负责展示与复制，
 * 解析与拼装逻辑集中在这里，保证两个入口行为一致。
 *
 * 支持：
 * - 字符串数组  ["a","b"]      → IN ('a', 'b')
 * - 数字数组    [1,2,3]        → IN (1, 2, 3)
 * - 对象数组    [{id:1},{id:2}] → 提取字段后 IN (1, 2)
 * - 引号风格 / 包裹格式 / 转义 / 去重 / null 处理 均可配置
 */

/** JSON 数组的元素类型 */
export type JsonElemType = "string" | "number" | "boolean" | "object" | "mixed";

/** parseJsonArray 的解析结果 */
export interface JsonArrayInfo {
  /** 是否为可用的数组（有效 JSON 且为非空数组） */
  ok: boolean;
  /** ok=false 时的原因 */
  reason?: "invalid-json" | "not-array" | "empty";
  /** 元素个数 */
  count: number;
  /** 主导元素类型（忽略 null 后判定） */
  elemType: JsonElemType;
  /** 对象数组时可提取的字段名（按首次出现顺序，去重） */
  fields: string[];
  /** 原始数组（ok=true 时有值） */
  values: unknown[];
}

/** SQL IN 生成选项 */
export interface SqlInOptions {
  /** 对象数组要提取的字段（基本类型数组可省略） */
  field?: string;
  /** 字符串引号风格，默认单引号（SQL 标准） */
  quote?: "single" | "double" | "backtick";
  /** 输出包裹格式，默认带 IN 关键字 */
  wrap?: "in" | "paren" | "values";
  /** 字符串内的引号字符翻倍转义（SQL 标准），默认开启 */
  escape?: boolean;
  /** 去重（按生成后的字面量），默认关闭 */
  dedupe?: boolean;
  /** null 的处理：输出 NULL 或跳过，默认输出 NULL */
  nullAs?: "NULL" | "skip";
}

const QUOTE_CHAR: Record<NonNullable<SqlInOptions["quote"]>, string> = {
  single: "'",
  double: '"',
  backtick: "`",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 分析一个已确认非空的数组：收集字段、判定主导类型 */
function analyzeArray(arr: unknown[]): JsonArrayInfo {
  // 收集字段（对象数组）：按首次出现顺序取键的并集
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (isPlainObject(item)) {
      for (const k of Object.keys(item)) {
        if (!seen.has(k)) { seen.add(k); fields.push(k); }
      }
    }
  }

  // 主导类型判定（忽略 null/undefined）
  const significant = arr.filter((v) => v !== null && v !== undefined);
  let elemType: JsonElemType;
  if (significant.length === 0) {
    elemType = "mixed";
  } else if (significant.every((v) => typeof v === "string")) {
    elemType = "string";
  } else if (significant.every((v) => typeof v === "number")) {
    elemType = "number";
  } else if (significant.every((v) => typeof v === "boolean")) {
    elemType = "boolean";
  } else if (significant.every(isPlainObject)) {
    elemType = "object";
  } else {
    elemType = "mixed";
  }

  return { ok: true, count: arr.length, elemType, fields, values: arr };
}

/**
 * 解析一段文本为 JSON 数组并分析其结构。
 * 解析失败 / 非数组 / 空数组时 ok=false，UI 据此决定是否展示工具箱。
 */
export function parseJsonArray(text: string): JsonArrayInfo {
  const fail = (reason: NonNullable<JsonArrayInfo["reason"]>): JsonArrayInfo => ({
    ok: false, reason, count: 0, elemType: "mixed", fields: [], values: [],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("invalid-json");
  }
  if (!Array.isArray(parsed)) return fail("not-array");
  if (parsed.length === 0) return fail("empty");

  return analyzeArray(parsed);
}

// ============ 对象内数组提取（P0 升级） ============

/** extractArrayFromJson 的返回结构：在 JsonArrayInfo 基础上附加来源信息 */
export interface ExtractedArrayInfo extends JsonArrayInfo {
  /** 数组来自对象的哪个字段（顶层数组时无此字段） */
  sourceField?: string;
  /** 对象中所有非空数组字段名（供 UI 字段选择 chip） */
  arrayFields?: string[];
}

/**
 * 增强版 JSON 数组提取：
 * 1. 顶层数组 → 直接命中（等价 parseJsonArray）
 * 2. 顶层对象 → 扫描所有值为非空数组的字段，取最长的作为数据源
 *
 * 典型场景：接口返回 {"data":[...],"total":5} → 提取 data 数组。
 * 不修改 parseJsonArray 本体，jsonInsert 等其他消费方按需切换。
 */
export function extractArrayFromJson(text: string): ExtractedArrayInfo {
  // 优先走顶层数组
  const direct = parseJsonArray(text);
  if (direct.ok) return direct;
  // 非 "not-array" 的失败（invalid-json / empty）直接透传
  if (direct.reason !== "not-array") return direct;

  // 尝试作为对象解析
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return direct;
  }
  if (!isPlainObject(parsed)) return direct;

  // 扫描所有非空数组字段，取最长
  const arrayFields: string[] = [];
  let best: { field: string; arr: unknown[] } | null = null;
  for (const [key, val] of Object.entries(parsed)) {
    if (Array.isArray(val) && val.length > 0) {
      arrayFields.push(key);
      if (!best || val.length > best.arr.length) {
        best = { field: key, arr: val };
      }
    }
  }

  if (!best) return direct; // 对象里没有任何数组字段

  const info = analyzeArray(best.arr);
  return { ...info, sourceField: best.field, arrayFields };
}

/**
 * 为对象数组挑选默认提取字段：优先 id 类命名（id/ID/Id、*Id、*_id、key/code），
 * 否则取首个字段；无字段返回 null。
 */
export function pickDefaultField(fields: string[]): string | null {
  if (fields.length === 0) return null;
  const idLike = fields.find((f) =>
    f === "id" || f === "ID" || f === "Id" ||
    /Id$/.test(f) || /_id$/.test(f) ||
    f === "key" || f === "code"
  );
  return idLike ?? fields[0];
}

/** 从对象数组中提取指定字段的值（非对象元素原样保留） */
export function pluckField(values: unknown[], field: string): unknown[] {
  return values.map((v) => (isPlainObject(v) ? v[field] : v));
}

/** 将单个值转为 SQL 字面量；无法表示（嵌套对象/数组、非有限数）返回 null */
export function toSqlLiteral(v: unknown, quote: string, escape: boolean): string | null {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") {
    const body = escape ? v.split(quote).join(quote + quote) : v;
    return quote + body + quote;
  }
  return null; // 嵌套对象/数组等不支持
}

/**
 * 把一组（已提取好的）原始值拼成 SQL IN 子句。
 * 返回 null 表示没有任何可输出的值（如全为嵌套对象）。
 */
export function toSqlIn(values: unknown[], opts: SqlInOptions = {}): string | null {
  const quote = QUOTE_CHAR[opts.quote ?? "single"];
  const escape = opts.escape ?? true;
  const nullAs = opts.nullAs ?? "NULL";
  const wrap = opts.wrap ?? "in";

  let literals: string[] = [];
  for (const v of values) {
    if (v === null || v === undefined) {
      if (nullAs === "skip") continue;
      literals.push("NULL");
      continue;
    }
    const lit = toSqlLiteral(v, quote, escape);
    if (lit !== null) literals.push(lit);
  }

  if (opts.dedupe) literals = [...new Set(literals)];
  if (literals.length === 0) return null;

  const joined = literals.join(", ");
  if (wrap === "values") return joined;
  if (wrap === "paren") return `(${joined})`;
  return `IN (${joined})`;
}

/** sqlInFromJson 的返回结构 */
export interface SqlInResult {
  ok: boolean;
  /** 生成的 SQL（ok=true 时有值） */
  sql?: string;
  /** 失败原因或提示 */
  message?: string;
  /** 解析信息（供 UI 复用） */
  info: JsonArrayInfo;
}

/**
 * 一步到位：解析 JSON 文本并生成 SQL IN（供卡片右键等一次性场景使用）。
 * 对象数组必须提供 opts.field（否则自动用 pickDefaultField 选默认字段）。
 */
export function sqlInFromJson(text: string, opts: SqlInOptions = {}): SqlInResult {
  const info = extractArrayFromJson(text);
  if (!info.ok) {
    const msg =
      info.reason === "invalid-json" ? "JSON 解析失败" :
      info.reason === "not-array" ? "未找到可用的 JSON 数组（顶层数组或对象内的数组字段）" :
      "数组为空，无法生成 IN 语句";
    return { ok: false, message: msg, info };
  }

  let values = info.values;
  if (info.elemType === "object") {
    const field = opts.field ?? pickDefaultField(info.fields);
    if (!field) return { ok: false, message: "对象数组没有可提取的字段", info };
    values = pluckField(info.values, field);
    return finish(values, { ...opts, field }, info);
  }
  return finish(values, opts, info);
}

function finish(values: unknown[], opts: SqlInOptions, info: JsonArrayInfo): SqlInResult {
  const sql = toSqlIn(values, opts);
  if (sql === null) return { ok: false, message: "没有可转换为 SQL 的值", info };
  return { ok: true, sql, info };
}
