/**
 * 标注态 OCR 选字分流判定（纯函数，便于单测，规则 7）。
 *
 * 背景：字层 .ocr-line 设 pointer-events:none，标注态所有 mousedown 收口到标注画布，
 * 由 onAnnotMouseDown 按 ocrSelectMode + 落点命中测试分流——标注与文字识别永不抢事件。
 */

import { isRowMasked } from "./maskGeom";
import type { Annotation, OcrSelectMode } from "./types";

/** 逐字框（物理像素，与选区/标注画布同坐标系）。ocrRectsRef 的每项即此形状（多一个 ch 字段无妨）。 */
export interface CharRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 落点命中哪个字。返回字 key（"行-列"），未命中返回 null。
 * 隐私行（被马赛克/模糊盖住）整字排除——选字不会选出被遮的密码/手机号。
 *
 * 走 buildLines（按引用缓存）而不是逐字 isRowMasked：本函数在 mousemove 里调，
 * 而 isRowMasked 对涂抹类遮罩要遍历笔画所有采点；千字级截图下就是每次移动
 * 几十万次运算。
 */
export function pointInAnyWord(
  px: number,
  py: number,
  rects: CharRect[],
  annotations: Annotation[],
): string | null {
  for (const l of buildLines(rects, annotations)) {
    // 行包围盒先粗筛，绝大多数行一步就被排除
    if (py < l.top || py > l.bottom || px < l.left || px > l.right) continue;
    for (const w of l.words) {
      if (px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) return w.key;
    }
  }
  return null;
}

/**
 * 选中某个字所在的**整行**。
 *
 * 用于「单击文字」：单击只能拿到一个字对用户几乎没用，而一整行才是人看到
 * 文字时想要的粒度（旧版行级框就是「点击复制此行」）。
 *
 * ❌ 找不到就返回**空集**，不能兜底成 `new Set([key])`：行被马赛克/模糊盖住时
 * buildLines 会排除它，兜底等于把刚排掉的隐私字又加回选区。宁可什么都不选。
 * （调用方拿到空集 → ocrSel.size 为 0 → 复制条不弹，仅此而已。）
 */
export function selectLine(
  rects: CharRect[],
  key: string,
  annotations: Annotation[],
): Set<string> {
  const li = parseInt(key.split("-")[0], 10);
  const out = new Set<string>();
  for (const l of buildLines(rects, annotations)) {
    if (l.line !== li) continue;
    for (const w of l.words) out.add(w.key);
  }
  return out;
}

/**
 * 是否应起手 OCR 选字（而非画标注）：
 *  - smart（默认）：落字内即选字。手势一旦起手就**不再翻转**：拖出文字区只会
 *    冻结已选内容（selectSpan 返回 null），不会变成画标注——正在选字突然变成画框
 *    比“选不到”更难接受。要在文字上画标注就切到任一具体工具（见 onAnnotMouseDown）。
 *  - modifier：需 Ctrl/⌘ + 落字内拖才选字；裸拖一律画标注（哪怕压着字）。
 */
export function shouldStartOcrSelect(
  hit: string | null,
  mode: OcrSelectMode,
  ctrlKey: boolean,
): boolean {
  return hit !== null && (mode === "smart" || (mode === "modifier" && ctrlKey));
}

/**
 * 跨行连续选字（阅读序 L 形）。
 *
 * 解决「智能意图拖选换行断掉」：选区不再按起手点→当前点的轴对齐矩形做重叠，
 * 而是按 key 的「行-列」重建阅读序，算从起手字到终点字的连续文本——
 *   起手行：选到行尾（向下拖）或行首（向上拖）；
 *   中间整行：全选；
 *   终点行：选到行首（向下）或行尾（向上）。
 *
 * 终点字解析：
 *   - 落在某字框内 → 用该字；
 *   - 落在行间空白但仍在「文字带」内（相邻行垂直容差≈1×行高、且横向在整段文字列范围内）
 *     → 取最近行的横向最近字（桥接换行，意图不断）；
 *   - 明显远离所有文字（>带）→ 返回 null，调用方据此转画标注。
 *
 * 隐私行（被马赛克/模糊盖住）按字排除，绝不进入选区。
 *
 * @returns 选中的字 key 集合；光标已离开文字带时返回 null。
 */
export function selectSpan(
  rects: CharRect[],
  startKey: string,
  px: number,
  py: number,
  annotations: Annotation[],
): Set<string> | null {
  const lines = buildLines(rects, annotations);
  if (lines.length === 0) return null;

  const [si, sj] = startKey.split("-").map(Number);

  // 1) 解析终点字
  const exact = pointInAnyWord(px, py, rects, annotations);
  let focusKey = exact;
  if (!focusKey) {
    const blockLeft = Math.min(...lines.map((l) => l.left));
    const blockRight = Math.max(...lines.map((l) => l.right));
    if (px < blockLeft - 40 || px > blockRight + 40) return null; // 横向已离文字列 → 离文字
    // 找垂直上最近的行（在 ±行高 带内）
    let best: LineGeo | null = null;
    let bestDist = Infinity;
    for (const l of lines) {
      if (py >= l.top - l.height && py <= l.bottom + l.height) {
        const d = Math.abs(py - l.centerY);
        if (d < bestDist) {
          bestDist = d;
          best = l;
        }
      }
    }
    if (!best) return null; // 垂直也离所有文字 → 离文字
    // 取该行横向最近字作为终点字（桥接换行）
    let fw = best.words[0];
    let fwd = Infinity;
    for (const w of best.words) {
      const d = Math.abs(px - (w.x + w.w / 2));
      if (d < fwd) {
        fwd = d;
        fw = w;
      }
    }
    focusKey = fw.key;
  }

  const [fi, fj] = focusKey.split("-").map(Number);
  const goingDown = fi > si || (fi === si && fj >= sj);

  const sel = new Set<string>();
  for (const l of lines) {
    const li = l.line;
    if (li === si && li === fi) {
      const a = Math.min(sj, fj);
      const b = Math.max(sj, fj);
      for (const w of l.words) if (w.col >= a && w.col <= b) sel.add(w.key);
    } else if (li === si) {
      for (const w of l.words) if (goingDown ? w.col >= sj : w.col <= sj) sel.add(w.key);
    } else if (li === fi) {
      for (const w of l.words) if (goingDown ? w.col <= fj : w.col >= fj) sel.add(w.key);
    } else if (li > Math.min(si, fi) && li < Math.max(si, fi)) {
      for (const w of l.words) sel.add(w.key);
    }
  }
  return sel;
}

interface LineWord {
  key: string;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface LineGeo {
  line: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
  centerY: number;
  words: LineWord[];
}

/**
 * 行几何缓存（按**引用**比对，所以永远不会返回过期结果）。
 *
 * 为什么要缓：selectSpan / pointInAnyWord 都在 mousemove 里调，而 buildLines 要建
 * Map + 数组并对每个字跑一遍 isRowMasked。拖选一次就重建几十次，千字级截图上
 * 直接卡手。拖选期间 rects 与 annotations 都不变，命中率是 100%。
 */
let lineCache: { rects: CharRect[]; annots: Annotation[]; lines: LineGeo[] } | null = null;

/** 把逐字框按「行-列」聚成行几何（阅读序），并排除隐私行。 */
function buildLines(rects: CharRect[], annotations: Annotation[]): LineGeo[] {
  if (lineCache && lineCache.rects === rects && lineCache.annots === annotations) {
    return lineCache.lines;
  }
  const lines = buildLinesUncached(rects, annotations);
  lineCache = { rects, annots: annotations, lines };
  return lines;
}

function buildLinesUncached(rects: CharRect[], annotations: Annotation[]): LineGeo[] {
  const map = new Map<number, LineWord[]>();
  for (const r of rects) {
    if (isRowMasked({ x: r.x, y: r.y, w: r.w, h: r.h }, annotations)) continue;
    const li = parseInt(r.key.split("-")[0], 10);
    const col = parseInt(r.key.split("-")[1], 10);
    if (!map.has(li)) map.set(li, []);
    map.get(li)!.push({ key: r.key, col, x: r.x, y: r.y, w: r.w, h: r.h });
  }
  const lines: LineGeo[] = [];
  for (const [li, ws] of map) {
    ws.sort((a, b) => a.x - b.x); // 同行按 x（=列序）排
    const top = Math.min(...ws.map((w) => w.y));
    const bottom = Math.max(...ws.map((w) => w.y + w.h));
    const left = Math.min(...ws.map((w) => w.x));
    const right = Math.max(...ws.map((w) => w.x + w.w));
    lines.push({
      line: li,
      top,
      bottom,
      left,
      right,
      height: bottom - top,
      centerY: (top + bottom) / 2,
      words: ws,
    });
  }
  lines.sort((a, b) => a.line - b.line);
  return lines;
}
