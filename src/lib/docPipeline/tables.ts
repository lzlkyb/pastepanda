/**
 * docPipeline/tables.ts — HTML 表格 → GFM 表格（含合并单元格检测与降级）。
 *
 * GFM 表格语法不支持 colspan/rowspan。检测到合并单元格时返回 null，
 * 由调用方决定降级策略（保留原文 HTML / 转 CSV / 展开填充）。
 */

/** 检测 HTML 片段里是否含合并单元格（colspan/rowspan） */
export function hasMergedCells(html: string): boolean {
  return /<t[dh][^>]*\b(?:colspan|rowspan)\s*=/i.test(html);
}

/**
 * 把 HTML 里的第一个 <table> 转成 GFM 表格。
 * 含合并单元格时返回 null（调用方应走降级）。
 * 无表格时返回 null。
 */
export function htmlTableToGfm(html: string): string | null {
  if (hasMergedCells(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  // 用 table.rows / row.cells 取直接子行/单元格，不穿透嵌套表格
  const rows = Array.from(table.rows);
  if (rows.length === 0) return null;

  const lines: string[] = [];
  let headerDone = false;

  for (const row of rows) {
    const cells = Array.from(row.cells);
    if (cells.length === 0) continue;
    const cellTexts = cells.map((c) => {
      // <br> 替换为空格，避免多行 cell 内容被压扁（textContent 不保留 <br>）
      const clone = c.cloneNode(true) as Element;
      clone.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
      return (clone.textContent || "")
        .trim()
        .replace(/\|/g, "\\|")
        .replace(/\n+/g, " ");
    });
    lines.push(`| ${cellTexts.join(" | ")} |`);
    if (!headerDone) {
      lines.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
      headerDone = true;
    }
  }

  return headerDone ? lines.join("\n") : null;
}

/** 把 HTML 里所有 <table> 各自转成 GFM（非表格部分原样保留为文本） */
export function htmlAllTablesToGfm(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    const gfm = htmlTableToGfm(table.outerHTML);
    if (gfm) {
      const pre = doc.createElement("pre");
      pre.textContent = gfm;
      table.replaceWith(pre);
    }
  }
  return doc.body.innerHTML;
}
