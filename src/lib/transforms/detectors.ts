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
  /** 解析出的值：全数字时为 number[]，否则为 string[] */
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
 * - 每行都是"单个值"：不含内部空白、不以 { 或 [ 开头（排除 JSON / 句子）。
 * 全行为数字时输出 number[]，否则原样输出 string[]。
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

  const simple = lines.every(
    (l) => !/\s/.test(l) && !l.startsWith("{") && !l.startsWith("["),
  );
  if (!simple) return fail;

  const allNumeric = lines.every((l) => l !== "" && Number.isFinite(Number(l)));
  const values: unknown[] = allNumeric ? lines.map((l) => Number(l)) : lines;

  return { ok: true, count: lines.length, values, allNumeric };
}

/** 便捷布尔判断 */
export function isColumnList(text: string): boolean {
  return parseColumnList(text).ok;
}
