/**
 * transforms/joinLines.ts — 多行竖列 → 单行合并（B 方案：分隔符 / 去重 / 排序）。
 *
 * 场景：从 Excel / 查询结果 / 别人发的清单里复制了一列 ID（每行一个），
 * 要贴进输入框、配置或消息里，需要压成一行逗号分隔——例如
 * 8 行 `YH2026…` 合并为 `YH2026…,YH2026…,…`。
 *
 * 与既有变换的分工：
 * - `sql-in` / `column-to-sql-in` / `delimited-to-sql-in`：产出 SQL 语法（引号 + IN 包裹）；
 * - 本变换：**纯文本拼接**，不加引号不包裹，分隔符可选；
 * - `sqlInReverse` 的「逗号分隔」选项：只从 `IN (...)` 里取值，输入形态不同。
 *
 * detect 复用 detectors.parseColumnList（与 SQL IN（按列）同一套竖列判据，
 * 修一处漏一处的问题不会再发生），另加一道中文长值过滤（口径与
 * parseDelimitedValues 的"中文长句不算数据列表"一致）：
 * 三行中文短句没有连续空格、也不超长，会被 parseColumnList 误认成列数据，
 * 不过滤的话会以 0.66 分挤进推荐区。
 */

import { parseColumnList } from "./detectors";
import type { Transform, TransformContext, TransformResult } from "./types";

/** 像列数据 → 进推荐区（枢纽推荐区阈值 0.6）；值越多越像，封顶 0.86 */
function columnScore(count: number): number {
  return Math.min(0.6 + count * 0.02, 0.86);
}

/** 其余多行文本：只在「其他变换」区露脸，不打扰推荐区 */
const MULTILINE_BASE = 0.3;

/** detect：竖列数据高分，普通多行 0.3，单行 / 空文本 0 */
function detect(ctx: TransformContext): number {
  const stats = ctx.features?.stats;
  if (stats ? stats.isEmpty : !ctx.text.trim()) return 0;

  const info = ctx.features?.columnList ?? parseColumnList(ctx.text);
  if (info.ok) {
    const values = info.values as string[];
    // 中文长值（>10 字）过半 → 自然语言段落（笔记、说明文），不是数据列。
    // 注意短中文行（姓名、短语名单）**不过滤**：名单合并成一行是真需求，
    // 宁可让「第一行内容」这类短句也进推荐区，也不埋没名单场景。
    const longCn = values.filter((v) => /[\u4e00-\u9fff]/.test(v) && v.length > 10).length;
    if (longCn > values.length * 0.5) return MULTILINE_BASE;
    return columnScore(info.count);
  }
  const multiline = stats ? stats.isMultiline : ctx.text.includes("\n");
  return multiline ? MULTILINE_BASE : 0;
}

function run(text: string, opts?: Record<string, unknown>): TransformResult {
  const sep = typeof opts?.sep === "string" && opts.sep ? opts.sep : ",";
  let values = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (values.length === 0) {
    return { ok: false, message: "没有可合并的内容" };
  }
  if ((opts?.dedupe ?? "off") === "on") {
    values = [...new Set(values)];
  }
  const sort = opts?.sort ?? "none";
  if (sort === "asc" || sort === "desc") {
    values = [...values].sort();
    if (sort === "desc") values.reverse();
  }
  return { ok: true, output: values.join(sep), meta: { count: values.length } };
}

export const joinLinesTransform: Transform = {
  id: "join_lines",
  label: "合并为单行",
  description: "把「每行一个值」的竖列合并成一行（分隔符 / 去重 / 排序）",
  icon: "list-collapse",
  group: "text",
  detect,
  run,
  options: [
    {
      key: "sep",
      label: "分隔符",
      values: [
        { value: ",", label: "," },
        { value: ", ", label: ", (带空格)" },
        { value: ";", label: ";" },
        { value: "|", label: "|" },
        { value: "、", label: "、" },
      ],
      default: ",",
    },
    {
      key: "dedupe",
      label: "去重",
      values: [
        { value: "off", label: "关" },
        { value: "on", label: "开" },
      ],
      default: "off",
    },
    {
      key: "sort",
      label: "排序",
      values: [
        { value: "none", label: "原序" },
        { value: "asc", label: "升序" },
        { value: "desc", label: "降序" },
      ],
      default: "none",
    },
  ],
};
