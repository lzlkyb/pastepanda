/**
 * OCR 行坐标 → 表格（几何聚类）。纯计算，从 ScreenshotOverlay 抽出以便单测。
 */

import type { OcrLine } from "@/lib/api/images";

/**
 * 把 OCR 行按几何位置聚成表格；行数 < 2 或只有单列时返回 null。
 *
 * ⚠️ 已知局限：每行按行包围盒（lineBox，words 逐字或整行两种形态都正确）的
 * x 做列分配，而文本用整行。所以只有当 OCR 把每个单元格识别成独立 line 时
 * 才能正确分列；若一行多列被归成一个 line，它会被当成单个单元格。
 */

/**
 * 行的整体包围盒。
 *
 * ⚠️ words 有两种形态：旧版「整行级单框」与逐字化后的「每字一框」。
 * 取全部字符框的并集对两种都正确（单框并集=它自身），避免像 `words[0]` 那样
 * 在逐字化后把行中心算到首字符上导致分列偏左。
 */
export function lineBox(line: OcrLine): { x: number; y: number; width: number; height: number } | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const w of line.words) {
    x1 = Math.min(x1, w.x);
    y1 = Math.min(y1, w.y);
    x2 = Math.max(x2, w.x + w.width);
    y2 = Math.max(y2, w.y + w.height);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * 把逐字词框聚合成「行级单框」。
 *
 * 用途：图片预览（ImagePreviewDialog / useImagePreview）这类「点一行复制整行」
 * 的旧交互。后端逐字化后每行是 N 个字符框，直接渲染会退化成"点一个字复制单字"、
 * hover 满屏小框；聚合回一行一框 + 整行文本，行为与逐字化前完全一致。
 * 已是整行单框的行原样返回（幂等）。返回新数组，不改入参。
 */
export function linesAsRowWords(lines: OcrLine[]): OcrLine[] {
  return lines.map((line) => {
    const b = lineBox(line);
    if (!b) return line;
    if (line.words.length === 1 && line.words[0].text === line.text) return line;
    return {
      ...line,
      words: [{ text: line.text, x: b.x, y: b.y, width: b.width, height: b.height }],
    };
  });
}

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
    const w = lineBox(line);
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
