/**
 * transforms/detectors.ts — 前端细粒度内容检测器（纯函数）。
 *
 * 后端 content_classifier 只给粗分类（json/number/code/color/text），
 * 这里在按需场景（打开编辑器 / 右键 / 枢纽）做更细的判断。
 * 当前阶段只实现 P0 需要的"按列值"检测；后续变换按需扩充。
 */

/** parseColumnList 的解析结果 */
export interface ColumnListInfo {
  ok: boolean;
  /** 值的行数 */
  count: number;
  /** 解析出的值：一律保持文本（string[]），是否加引号由下游 SQL 选项决定 */
  values: unknown[];
  /** 是否全为数字 */
  allNumeric: boolean;
}

/** 至少多少行才算"按列数据"（单行太容易误判） */
const MIN_COLUMN_LINES = 2;

/**
 * 把"每行一个值"的竖列文本解析为值数组。
 * 判定规则：
 * - 去掉空行后行数 ≥ MIN_COLUMN_LINES；
 * - 每行都是"单个值"：
 *   - 含 tab 时取第一列（Excel 多列粘贴）；
 *   - 允许至多一处内部空格且总长 ≤ 60（"New York" 类值）；
 *   - 不含连续多空格（排除自然语言句子）；
 *   - 不以 { 或 [ 开头（排除 JSON）。
 * 值一律保持文本输出（string[]）：列数据来源是文本（Excel / 查询结果单元格），
 * 提前转 number 会让 SQL IN 的引号选项对数字列失效，还会丢前导零与超 2^53 精度。
 */
export function parseColumnList(text: string): ColumnListInfo {
  const fail: ColumnListInfo = { ok: false, count: 0, values: [], allNumeric: false };

  // 廉价早退：单行文本不可能是按列数据，避免对长文本做无谓 split
  if (!text.includes("\n")) return fail;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < MIN_COLUMN_LINES) return fail;

  const values: string[] = [];
  for (const l of lines) {
    // Tab 分隔：取第一列（Excel / 查询结果多列粘贴）
    const field = l.includes("\t") ? l.split("\t")[0].trim() : l;
    if (!field) return fail;
    if (field.startsWith("{") || field.startsWith("[")) return fail;
    // 连续多空格 → 自然语言句子，拒绝
    if (/\s{2,}/.test(field)) return fail;
    // 含单空格但过长 → 不像 ID/值，拒绝
    if (/\s/.test(field) && field.length > 60) return fail;
    values.push(field);
  }

  // allNumeric 仅供检测评分使用；values 保持文本，引号交给下游 toSqlIn 的 quote 选项
  const allNumeric = values.every((v) => v !== "" && Number.isFinite(Number(v)));

  return { ok: true, count: values.length, values, allNumeric };
}

/** 便捷布尔判断 */
export function isColumnList(text: string): boolean {
  return parseColumnList(text).ok;
}

/** parseDelimitedValues 的解析结果 */
export interface DelimitedInfo {
  ok: boolean;
  /** 解析出的值（一律保持文本） */
  values: string[];
  /** 命中的分隔符 */
  delimiter: string;
  /** 值的个数 */
  count: number;
}

/** 支持的分隔符（按优先级；最后一个是中文逗号） */
const DELIMITERS = [",", ";", "|", "，"] as const;

/** 可剥的外层成对括号 */
const BRACKET_PAIRS: Record<string, string> = { "[": "]", "(": ")", "{": "}" };

/** 至少多少个值才算“分隔值列表”（再少太容易误判） */
const MIN_DELIMITED_VALUES = 3;

/**
 * 把“一行（或极少行）逗号 / 分号 / 竖线分隔”的横排文本解析为值数组。
 * 与 parseColumnList 互补：那个处理竖列（\n 分隔），这个处理横排。
 *
 * 会剥掉一层外层成对括号：`[a, b, c]` / `(a, b, c)` / `{a, b, c}`。
 * 不剥的话首尾两个值会带上括号（如 '[076300…' 与 '…385]'），
 * 生成的 SQL 语法合法却永远查不中这两条，属于不报错的静默错误。
 *
 * 值一律保持文本：业务 ID 常是带前导零的超长号，
 * 转 number 会同时丢前导零与超 2^53 的精度。
 *
 * 共享给 analyzer.ts（预计算 features.delimited）与 delimitedSqlIn.ts（run 兼兼底），
 * 不再各自留一份副本——两套机制下修一处漏一处。
 */
export function parseDelimitedValues(text: string): DelimitedInfo {
  const fail: DelimitedInfo = { ok: false, values: [], delimiter: "", count: 0 };

  const trimmed = text.trim();
  if (!trimmed) return fail;

  // 行数检查：允许最多 3 行（复制常带尾部换行或两行拼接）
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0 || lines.length > 3) return fail;

  // 合并为单行统一处理
  let single = lines.join(" ").trim();

  // 剥一层外层成对括号
  const close = BRACKET_PAIRS[single[0]];
  if (close && single.length >= 2 && single.endsWith(close)) {
    single = single.slice(1, -1).trim();
    if (!single) return fail;
  }

  for (const delim of DELIMITERS) {
    const parts = single.split(delim);
    if (parts.length < MIN_DELIMITED_VALUES) continue;

    const values = parts.map((p) => p.trim()).filter((p) => p.length > 0);
    if (values.length < MIN_DELIMITED_VALUES) continue;

    // 排除自然语言：值内不应有连续多空格，也不应过长
    const allSimple = values.every((v) => !/\s{2,}/.test(v) && v.length <= 100);
    if (!allSimple) continue;

    // 排除句子被逗号分割：过半的值是长中文串
    const longChinese = values.filter((v) => /[一-鿿]/.test(v) && v.length > 10);
    if (longChinese.length > values.length * 0.5) continue;

    return { ok: true, values, delimiter: delim, count: values.length };
  }

  return fail;
}
