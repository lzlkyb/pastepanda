/**
 * Markdown 表格的输入辅助（B1 #12）——纯函数，不碰编辑器。
 *
 * 只做一件事：**在表格行里用 Tab / Shift+Tab 跳单元格**。
 * 不做列宽对齐、不做表格重排：那些会在每次敲字时改写整行，
 * 而 CodeMirror 的撤销栈会因此变得很难用。
 *
 * 判定强度故意做得保守（行首必须是 `|`）：宁可漏接管，不能把普通行的 Tab 抢走。
 */

/** 这一行看着像不像 Markdown 表格行。 */
export function isTableRow(line: string): boolean {
  return line.trimStart().startsWith("|");
}

/**
 * 把一行表格拆成单元格的【起, 止】区间（相对行首，不含两侧的 `|`）。
 *
 * 转义过的 `\|` 不算分隔符——表格里写管道符就靠它，漏了会把一格切成两格。
 */
export function cellRanges(line: string): { from: number; to: number }[] {
  if (!isTableRow(line)) return [];

  const bars: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "|") continue;
    // 数前面连续的反斜杠：奇数个 = 被转义
    let back = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) back++;
    if (back % 2 === 0) bars.push(i);
  }
  if (bars.length < 2) return [];

  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < bars.length - 1; i++) {
    out.push({ from: bars[i] + 1, to: bars[i + 1] });
  }
  return out;
}

/**
 * 光标在哪个单元格（下标）。不在任何单元格内返回 -1。
 *
 * 边界归属：恰好落在分隔符上时算**左边那格**，这样在行尾 `|` 处按 Tab 才会往下一行走。
 */
export function cellIndexAt(line: string, col: number): number {
  const cells = cellRanges(line);
  for (let i = 0; i < cells.length; i++) {
    if (col >= cells[i].from && col <= cells[i].to) return i;
  }
  return -1;
}

/**
 * 算 Tab / Shift+Tab 后光标该去哪。
 *
 * 返回相对行首的列位置（落在目标单元格内容的起始处，跳过前导空格）；
 * 已经在本行首/尾格、再走就超出本行时返回 null（交给调用方决定换行还是放行）。
 */
export function nextCellCol(line: string, col: number, dir: 1 | -1): number | null {
  const cells = cellRanges(line);
  if (cells.length === 0) return null;

  const cur = cellIndexAt(line, col);
  if (cur < 0) return null;

  const target = cur + dir;
  if (target < 0 || target >= cells.length) return null;

  const { from, to } = cells[target];
  // 跳过单元格内的前导空格，落在真正的内容开头
  let p = from;
  while (p < to && line[p] === " ") p++;
  return p;
}

/**
 * 根据表头行生成分隔行（`| --- | --- |`）。
 *
 * 用于「写完表头按回车自动补分隔行」——没有分隔行的表格在任何 Markdown 渲染器里都不是表格，
 * 而这一行手敲最烦。缩进与行首对齐。
 */
export function separatorRow(headerLine: string): string {
  const cells = cellRanges(headerLine);
  if (cells.length === 0) return "";
  const indent = headerLine.slice(0, headerLine.length - headerLine.trimStart().length);
  return `${indent}|${cells.map(() => " --- ").join("|")}|`;
}
