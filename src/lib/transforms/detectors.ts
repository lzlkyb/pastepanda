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
