/**
 * OCR 行坐标 → 表格（几何聚类）。纯计算，从 ScreenshotOverlay 抽出以便单测。
 */

import type { OcrLine } from "@/lib/api/images";

/**
 * 把 OCR 行按几何位置聚成表格；行数 < 2 或只有单列时返回 null。
 *
 * ⚠️ 已知局限：每行只取 `line.words[0]` 的 x 做列分配，而文本用整行。
 * 所以只有当 OCR 把每个单元格识别成独立 line 时才能正确分列；
 * 若一行多列被归成一个 line，它会被当成单个单元格。
 */
export function ocrToTable(lines: OcrLine[]): string[][] | null {
  if (lines.length < 2) return null;
  interface Cell {
    x: number;
    cx: number;
    text: string;
  }
  interface Row {
    y: number;
    cells: Cell[];
  }
  const rows: Row[] = [];
  for (const line of lines) {
    const w = line.words[0];
    if (!w) continue;
    const cy = w.y + w.height / 2;
    const tol = Math.max(10, w.height * 0.6);
    const row = rows.find((r) => Math.abs(r.y - cy) < tol);
    if (row) {
      row.cells.push({ x: w.x, cx: w.x + w.width / 2, text: line.text });
    } else {
      rows.push({ y: cy, cells: [{ x: w.x, cx: w.x + w.width / 2, text: line.text }] });
    }
  }
  rows.sort((a, b) => a.y - b.y);
  if (rows.length < 2) return null;

  // 列边界：所有词 x 排序，间隙 > 阈值（间隙中位数 × 3）切列
  const xs = rows.flatMap((r) => r.cells.map((c) => c.x)).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const g = xs[i] - xs[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const gapMid = gaps[Math.floor(gaps.length / 2)];
  const cutThreshold = Math.max(24, gapMid * 3);
  const bounds: number[] = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] > cutThreshold) bounds.push(xs[i]);
  }
  if (bounds.length < 2) return null; // 单列不是表格
  bounds.push(xs[xs.length - 1] + 1);

  // 词分配到最近列
  return rows.map((r) => {
    const cells = new Array<string>(bounds.length - 1).fill("");
    for (const c of r.cells) {
      let best = 0;
      let bestDist = Number.MAX_SAFE_INTEGER;
      for (let i = 0; i < bounds.length - 1; i++) {
        const center = (bounds[i] + bounds[i + 1]) / 2;
        const d = Math.abs(c.cx - center);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      cells[best] = cells[best] ? cells[best] + " " + c.text : c.text;
    }
    return cells;
  });
}

/** CSV 字段转义：含逗号/引号/换行时加引号，内部引号双写 */
export function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
