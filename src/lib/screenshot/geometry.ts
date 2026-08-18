/**
 * 截图的几何纯函数：坐标系换算、磁吸对齐、标注命中检测。
 *
 * 从 ScreenshotOverlay 抽出来的原因：这几个函数里藏过两个真 bug（坐标没减 origin、
 * 磁吸把 x/y 候选混在一起），而它们全是无副作用的纯计算——放在 3000 行的组件里
 * 既测不了也看不见。抽出来后可以直接写回归测试（规则 7：纯计算抽到 lib/）。
 */

import { maskBrushWidth } from "./maskGeom";
import type { Annotation, Rect, ScreenInfo, SnapRect, SnapTargets } from "./types";

/* ===== 坐标系换算（多显示器必需） =====
 * 底图 / 选区 / Canvas 用的是「底图局部坐标」，原点在虚拟屏幕左上角；
 * 后端的 snap_window_at / get_cursor_pos / send_mouse_wheel 用的是「屏幕坐标」。
 * 两者差一个 (originX, originY)。主显示器在最左上时 origin=(0,0)，两者恰好相等——
 * 这就是原来漏掉换算却看不出问题的原因；副屏摆在主屏左边/上边时
 * SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN 为负，不换算就会整体偏移。
 * ⚠️ 新增任何跟后端交换坐标的调用，必须走这两个函数，不要裸算（规则 11.1）。 */

/** 底图局部坐标 → 屏幕坐标 */
export function toScreenPt(s: ScreenInfo | null, x: number, y: number): [number, number] {
  return [x + (s?.originX ?? 0), y + (s?.originY ?? 0)];
}

/** 屏幕坐标矩形 → 底图局部坐标矩形 */
export function toLocalRect(s: ScreenInfo | null, r: SnapRect): Rect {
  return { x: r.x - (s?.originX ?? 0), y: r.y - (s?.originY ?? 0), w: r.w, h: r.h };
}

/** 磁吸阈值（物理像素） */
export const MAGNET_T = 8;

/**
 * 磁吸：选区边缘贴近 屏幕边 / 中心线 / 参照窗口边缘（≤ 8px）时吸附对齐。
 *
 * ⚠️ 水平候选只能用参照矩形的 x 边，垂直候选只能用 y 边。
 * 原实现把 [x, x+w, y, y+h] 一股脑塞进四个数组，于是选区左边缘会吸到窗口的 top 值、
 * 上边缘会吸到窗口的 left 值——表现就是拖选时选区莫名跳一下。
 */
export function applyMagnet(r: Rect, refs: Rect[], sw: number, sh: number): Rect {
  const T = MAGNET_T;
  const midX = sw / 2;
  const midY = sh / 2;
  const xEdges = refs.flatMap((b) => [b.x, b.x + b.w]);
  const yEdges = refs.flatMap((b) => [b.y, b.y + b.h]);
  const lefts = [0, midX, ...xEdges];
  const rights = [sw, midX, ...xEdges];
  const tops = [0, midY, ...yEdges];
  const bottoms = [sh, midY, ...yEdges];
  let x = r.x;
  let y = r.y;
  let x2 = r.x + r.w;
  let y2 = r.y + r.h;
  for (const c of lefts)
    if (Math.abs(x - c) <= T) {
      x = c;
      break;
    }
  for (const c of rights)
    if (Math.abs(x2 - c) <= T) {
      x2 = c;
      break;
    }
  for (const c of tops)
    if (Math.abs(y - c) <= T) {
      y = c;
      break;
    }
  for (const c of bottoms)
    if (Math.abs(y2 - c) <= T) {
      y2 = c;
      break;
    }
  return { x, y, w: Math.max(4, x2 - x), h: Math.max(4, y2 - y) };
}

/**
 * 吸附迟滞：决定 hover 时是否从当前选区切换到新的吸附矩形。
 *
 * 防的是「光标在窗口 / 控件边界附近微抖」时，吸附框在「整窗 ↔ 子控件 / 邻窗」之间反复跳。
 * 规则（px/py 为光标在底图局部坐标，hyst 默认 6）：
 *   - 首次吸附（cur 为空）→ 直接采用 next；
 *   - next 为空（桌面空白）→ 仅当光标明显离开当前窗口（超出 hyst）才清除，防边角闪烁；
 *   - next 是当前 cur 的真子控件且光标明显在内（离各边 ≥ hyst）→ 下钻到子控件；
 *   - 光标明显已离开当前选区 → 切换到 next（邻窗 / 兄弟控件 / 回到整窗）；
 *   - 否则保持 cur（光标仍在当前区内、且未明确下钻）。
 */
export function resolveSnapTarget(
  cur: Rect | null,
  next: Rect | null,
  px: number,
  py: number,
  hyst = 6,
): Rect | null {
  if (!cur) return next;
  if (!next) return outsideRect(px, py, cur, hyst) ? null : cur;
  const stillInsideCur = !outsideRect(px, py, cur, hyst);
  const drillDown =
    next.x >= cur.x - 0.5 &&
    next.y >= cur.y - 0.5 &&
    next.x + next.w <= cur.x + cur.w + 0.5 &&
    next.y + next.h <= cur.y + cur.h + 0.5 &&
    px >= next.x + hyst &&
    px <= next.x + next.w - hyst &&
    py >= next.y + hyst &&
    py <= next.y + next.h - hyst;
  if (stillInsideCur && !drillDown) return cur;
  return next;
}

/** 点是否落在矩形外（含 margin 扩张），用于迟滞判定。 */
function outsideRect(px: number, py: number, r: Rect, m: number): boolean {
  return px < r.x - m || px > r.x + r.w + m || py < r.y - m || py > r.y + r.h + m;
}

/** 点到线段距离（箭头命中检测） */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 点是否命中标注元素（选中 / 橡皮擦共用；eraser 永不命中） */
export function pointHitAnnot(px: number, py: number, a: Annotation): boolean {
  const x = Math.min(a.x, a.x2);
  const y = Math.min(a.y, a.y2);
  const w = Math.abs(a.x2 - a.x);
  const h = Math.abs(a.y2 - a.y);
  // 遮罩类的**涂抹**笔刷比线宽粗很多（见 maskBrushWidth），命中容差必须跟笔刷宽度走，
  // 否则用户点在看得见的笔迹上却选不中（笔宽 40px、容差却只有 8px）。
  const pad =
    a.shape === "brush" && (a.type === "mosaic" || a.type === "blur" || a.type === "highlight")
      ? maskBrushWidth(a) / 2
      : Math.max(8, a.width);
  switch (a.type) {
    case "rect":
    case "highlight":
    case "mosaic":
    case "blur":
    case "text": {
      return px >= x - pad && px <= x + w + pad && py >= y - pad && py <= y + h + pad;
    }
    case "ellipse": {
      if (w <= 0 || h <= 0) return false;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const dx = (px - cx) / (w / 2 + pad);
      const dy = (py - cy) / (h / 2 + pad);
      return dx * dx + dy * dy <= 1;
    }
    case "arrow": {
      return distToSegment(px, py, a.x, a.y, a.x2, a.y2) < Math.max(8, a.width * 2);
    }
    case "pen": {
      if (!a.points) return false;
      const t = Math.max(8, a.width + 3);
      for (const [ax, ay] of a.points) {
        if (Math.abs(px - ax) <= t && Math.abs(py - ay) <= t) return true;
      }
      return false;
    }
    case "number": {
      const r = (a.size ?? 18) / 2 + 4;
      const cx = a.x + r;
      const cy = a.y + r;
      return Math.hypot(px - cx, py - cy) <= r;
    }
    default:
      return false;
  }
}

/** 橡皮擦：擦除路径经过的所有标注元素 id。
 *
 *  保留给“整删”语义用；eraseStrokes 内部对非笔迹类就是这个行为。 */
export function eraseHits(points: [number, number][], annots: Annotation[]): number[] {
  const hit = new Set<number>();
  for (const [px, py] of points) {
    for (const a of annots) {
      if (a.type === "eraser") continue;
      if (pointHitAnnot(px, py, a)) hit.add(a.id);
    }
  }
  return [...hit];
}

/** 笔迹类（有 points、能被“擦掉一段”的）。
 *
 *  马赛克/模糊/高亮 只有 `shape === "brush"` 时才算笔迹；
 *  拖矩形的那些没有“一段”的概念，只能整删。 */
function isStrokeLike(a: Annotation): boolean {
  if (!a.points || a.points.length === 0) return false;
  if (a.type === "pen") return true;
  return a.shape === "brush" && (a.type === "mosaic" || a.type === "blur" || a.type === "highlight");
}

export interface EraseResult {
  /** 要整个删掉的标注 id（包括被切分的原笔迹） */
  deleted: number[];
  /** 切分后产生的新笔迹段（id 由调用方的 nextId 分配） */
  split: Annotation[];
}

/**
 * 真橡皮擦：擦到笔迹就**把它切成多段**，擦到形状/文字才整个删。
 *
 * 旧行为（eraseHits）是“划到就整个删”：用户画了一条长曲线，轻轻擦一下
 * 整条就没了——那叫“点选删除”，不叫橡皮擦。
 *
 * 为什么是混合行为而不是统一切分：矩形 / 椭圆 / 箭头 / 文字 / 序号 没有
 * “一段”的概念，把一个矩形擦出个缺口需要把它栅格化，那之后就不能再选中/移动了。
 *
 * @param points 橡皮轨迹采样点
 * @param radius 橡皮半径（物理像素）
 * @param minSeg 切分后不足这么多点的碎段丢掉（默认 2）。
 *               不丢的后果：擦完会剩下一堆孤立圆点，看起来像没擦干净。
 */
export function eraseStrokes(
  points: [number, number][],
  annots: Annotation[],
  radius: number,
  minSeg = 2,
): EraseResult {
  const deleted: number[] = [];
  const split: Annotation[] = [];
  const r2 = radius * radius;

  /** 采样点是否落在橡皮轨迹的半径内 */
  const rubbed = (x: number, y: number) =>
    points.some(([ex, ey]) => {
      const dx = x - ex;
      const dy = y - ey;
      return dx * dx + dy * dy <= r2;
    });

  for (const a of annots) {
    if (a.type === "eraser") continue;

    if (!isStrokeLike(a)) {
      // 非笔迹类：沿用旧的“碰到就整删”
      if (points.some(([px, py]) => pointHitAnnot(px, py, a))) deleted.push(a.id);
      continue;
    }

    const pts = a.points!;
    // 把连续的“未被擦到”点收成一段
    const segs: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (const p of pts) {
      if (rubbed(p[0], p[1])) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else {
        cur.push(p);
      }
    }
    if (cur.length) segs.push(cur);

    const kept = segs.filter((s) => s.length >= minSeg);

    // 一点都没擦到：原封不动（段数为 1 且长度不变）
    if (kept.length === 1 && kept[0].length === pts.length) continue;

    // 否则原笔迹作废，保留的段各自变成一条新笔迹。
    // id 先给 0，由调用方用 nextId() 重新分配——纯函数不能持有自增状态，
    // 否则就测不了。
    deleted.push(a.id);
    for (const s of kept) {
      split.push({ ...a, id: 0, points: s, x: s[0][0], y: s[0][1], x2: s[s.length - 1][0], y2: s[s.length - 1][1] });
    }
  }

  return { deleted, split };
}

/**
 * 双层吸附迟滞：在「整窗 ↔ 子控件 / 邻窗」之间做防抖，返回 `{ win, ctrl }` 双层目标。
 *
 * 复用 `resolveSnapTarget`（单层迟滞）分别处理两层，但保证 ctrl 永远归属当前 win：
 *   - `cur` 为空 → 直接采用 `next`（首次吸附）；
 *   - `next` 为空（桌面空白）→ 仅当光标明显离开当前 `win` 才清除，防边角闪烁；
 *   - `win` 层先决定切到哪个窗口：离开所有窗口返回 null；
 *   - 切换了窗口 → `ctrl` 直接用新窗口内的控件（不能沿用旧窗口的 ctrl）；
 *   - 同窗口内 → `ctrl` 层用迟滞决定是否下钻到更细控件 / 切到兄弟控件 / 保持。
 */
export function resolveSnapTargets(
  cur: SnapTargets | null,
  next: SnapTargets | null,
  px: number,
  py: number,
  hyst = 6,
): SnapTargets | null {
  if (!cur) return next;
  if (!next) {
    // 桌面空白：光标明显离开当前窗口才清除当前吸附（含 ctrl），防边角微抖闪烁
    return outsideRect(px, py, cur.win, hyst) ? null : cur;
  }
  // win 层：决定切换到哪个窗口
  const winNext = resolveSnapTarget(cur.win, next.win, px, py, hyst);
  if (!winNext) return null; // 已离开所有顶层窗口
  if (winNext !== cur.win) {
    // 切换了窗口 → ctrl 直接用新窗口内的控件，避免 ctrl 残留在旧窗口
    return { win: winNext, ctrl: next.ctrl };
  }
  // win 没变 → ctrl 层单独迟滞（下钻 / 切兄弟控件 / 保持）
  const ctrlNext = resolveSnapTarget(cur.ctrl, next.ctrl, px, py, hyst);
  return { win: cur.win, ctrl: ctrlNext ?? cur.ctrl };
}
