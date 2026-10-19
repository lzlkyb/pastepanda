/**
 * 预览里「把这张表复制走」：TSV（贴 Excel）与内联样式的 HTML（贴 Word / 邮件）。
 *
 * 为什么两种格式一起写：剪贴板一次可以放多个 MIME，接收方各取所需。
 * 只给 TSV 的话贴到 Word 里是一堆制表符；只给 HTML 的话贴到 Excel 里
 * 会变成图片或一整个单元格。两个都写，用户不用先想「我要贴到哪」。
 *
 * 🔴 红线：无 AI。纯 DOM 读取 + 字符串生成，不写回文档。
 */
import { escapeHtml } from "./html";

/**
 * 单元格文本：`innerText` 会把 `<br>` 还原成换行，`textContent` 不会。
 * jsdom 里没有 innerText（返回 undefined），故退到 textContent —— 单测因此
 * 只能覆盖单行单元格，这点在测试里写明。
 */
function cellText(cell: HTMLTableCellElement): string {
  const raw = (cell as HTMLElement).innerText ?? cell.textContent ?? "";
  return raw
    .replace(/\r/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\t/g, " ")
    .trim();
}

/**
 * 表格 → 文本矩阵。`colspan` 展开成「首列有值 + 其余空串」，
 * `rowspan` 用占位矩阵向下补空串 —— 不补的话后面的列会在粘贴到 Excel 时整体左移。
 *
 * 合并单元格在 Markdown 里本来不存在（GFM 不支持），但预览可能是别的文档
 * 或手写 HTML 渲染来的，按最坏情况处理不至于错位。
 */
export function tableToMatrix(table: HTMLTableElement): string[][] {
  const matrix: string[][] = [];
  // 上方 rowspan 还占着的列 → 剩余行数
  const occupied = new Map<number, number>();

  for (const row of Array.from(table.rows)) {
    const line: string[] = [];
    const queue = Array.from(row.cells);
    let col = 0;

    // 条件里带 queue.length：只被上方 rowspan 占满、本行没有 cell 时也要收尾
    while (queue.length > 0 || occupied.size > 0) {
      const left = occupied.get(col);
      if (left != null) {
        line[col] = "";
        if (left > 1) occupied.set(col, left - 1);
        else occupied.delete(col);
        col += 1;
        continue;
      }
      const cell = queue.shift();
      if (!cell) break;

      const text = cellText(cell);
      const colSpan = Math.max(1, cell.colSpan);
      const rowSpan = Math.max(1, cell.rowSpan);
      for (let i = 0; i < colSpan; i += 1) {
        line[col] = i === 0 ? text : "";
        if (rowSpan > 1) occupied.set(col, rowSpan - 1);
        col += 1;
      }
    }

    // 补齐到最长行宽由调用方处理，这里保持真实列数
    matrix.push(line);
  }

  return matrix;
}

/** 表格 → TSV（Excel / Sheets / 剪贴板纯文本粘贴） */
export function tableToTsv(table: HTMLTableElement): string {
  return tableToMatrix(table)
    .map((row) => row.map((cell) => cell.replace(/\t/g, " ")).join("\t"))
    .join("\r\n");
}

/**
 * 表格 → 可直接粘进 Word / 邮件 / 飞书的 HTML 片段。
 *
 * 样式必须内联：Word 和多数邮件客户端会丢掉 `<style>` 块与 class。
 * 这里的颜色是**运行期常量而非主题变量**——粘贴目标不在本项目主题体系里，
 * 给 var(--border-color) 到 Word 里就是无效值。
 */
export function tableToRichHtml(table: HTMLTableElement): string {
  const matrix = tableToMatrix(table);
  if (matrix.length === 0) return "";
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];

  const border = "#bfbfbf"; /* ui-rule-ok: 运行期导出常量，落点是 Word 而非本项目主题 */
  const headBg = "#f2f2f2"; /* ui-rule-ok: 同上 */
  const cellStyle = `border:1px solid ${border};padding:6px 10px;font-size:13px;vertical-align:top;`;

  const [head, ...body] = matrix.map(pad);
  const thead =
    `<thead><tr>` +
    head
      .map(
        (cell) =>
          `<th style="${cellStyle}background:${headBg};text-align:left;font-weight:600;">${escapeHtml(cell)}</th>`,
      )
      .join("") +
    `</tr></thead>`;
  const tbody =
    `<tbody>` +
    body
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td style="${cellStyle}">${escapeHtml(cell)}</td>`).join("")}</tr>`,
      )
      .join("") +
    `</tbody>`;

  return (
    `<table style="border-collapse:collapse;font-family:Segoe UI,'Microsoft YaHei',sans-serif;">` +
    thead +
    tbody +
    `</table>`
  );
}
