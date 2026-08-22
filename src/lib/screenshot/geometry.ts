/**
 * 截图的几何纯函数：坐标系换算、磁吸对齐、标注命中检测。
 *
 * 从 ScreenshotOverlay 抽出来的原因：这几个函数里藏过两个真 bug（坐标没减 origin、
 * 磁吸把 x/y 候选混在一起），而它们全是无副作用的纯计算——放在 3000 行的组件里
 * 既测不了也看不见。抽出来后可以直接写回归测试（规则 7：纯计算抽到 lib/）。
 */

import { maskBrushWidth } from "./maskGeom";
import { measureTextExtent, TEXT_SIZE } from "./draw";
export { measureTextExtent };
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

/**
 * 把矩形钳制到 [0, sw] × [0, sh] 内（底图局部坐标）。
 *
 * 用途：后端窗口/控件矩形（UIA CurrentBoundingRectangle / DWM EXTENDED_FRAME_BOUNDS）
 * 在部分机器（高 DPI 偏移 / 全屏窗口阴影扩展）会返回出界矩形（负坐标或超界），
 * 直接 setSel 会让标注态 shade-block 蒙版按出界矩形画 → 截图被视觉切成 4 段。
 * 与 resizing 把手拖拽的 clamped 同款逻辑，抽成纯函数便于回归。
 * 钳制规则：w/h 收到 ≤ 屏幕尺寸（保底 1px）；x/y 收进 [0, sw-w] / [0, sh-h]。
 *
 * ⚠️ 后端 snap_window_at / enum_controls / enum_window_rects 已在返回前统一钳制
 * （screenshot.rs clamp_rect_to_screen，与这里数学等价：后端钳 [origin, origin+size]，
 * toLocalRect 减 origin 后即 [0, size]）。此函数保留为双保险兜底（护其它消费方）。
 */
export function clampRect(r: Rect, sw: number, sh: number): Rect {
  const w = Math.max(1, Math.min(r.w, sw));
  const h = Math.max(1, Math.min(r.h, sh));
  return {
    x: Math.max(0, Math.min(r.x, Math.max(0, sw - w))),
    y: Math.max(0, Math.min(r.y, Math.max(0, sh - h))),
    w,
    h,
  };
}

/** 磁吸阈值（物理像素） */
export const MAGNET_T = 8;

/**
 * 拖选被认定为「真的在拉框」的最小边长（物理像素）。
 *
 * ❗ 与下面 applyMagnet 返回值里的 `Math.max(4, …)` 是**两件事**，别混：
 *  - 这里的 DRAG_MIN 是**语义判据**：拖了这么多才算画新选区，否则算单击；
 *  - 那里的 4 是**防退化**：磁吸后不产出 0 宽高的矩形（手柄缩放也走 applyMagnet）。
 *
 * 曾经把两者混为一谈：显示门槛判 `selDraft.w >= 4` 而 selDraft 出自 applyMagnet，
 * 于是鼠标一动门槛必然成立 → 选区框先塌成光标处 4×4 小点，松手时提交门槛按原始距离
 * 判成单击又跳回吸附窗口，用户看到「单击确定闪一下」。
 * 显示与提交必须引用这同一个常量、且都作用在**原始**拖动距离上。
 */
export const DRAG_MIN = 4;

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
  // 宽高兜底 4：磁吸后不产出退化矩形（手柄缩放也走这里）。
  // ⚠️ 这个 4 不是「拖选算不算有效」的判据 —— 那个是 DRAG_MIN，作用在原始拖动距离上。
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
      // 文字标注提交时已把真实宽高写进 x2/y2；但旧标注（x2===x 退化）没有，
      // 这时用 measureTextExtent 实时量出真实包围盒——否则只有落点 8px 内能选中，
      // 点到实际可见文字（右下方向）永远选不中、改不了（用户反馈）。
      const fs = a.size ?? TEXT_SIZE;
      const ext = measureTextExtent(a.text ?? "", fs);
      // 用顶部已归一化的 x/w/h（已 abs 处理反向坐标），否则 x2<x 的反选矩形/文字
      // 命中框会变成负宽 → 选不中（ellipse/arrow 已归一化，这里漏了）。
      const bw = Math.max(ext.w, w);
      const bh = Math.max(ext.h, h);
      const tpad = Math.max(8, fs / 6);
      return px >= x - tpad && px <= x + bw + tpad && py >= y - tpad && py <= y + bh + tpad;
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
      // 主线段命中（箭头杆）
      if (distToSegment(px, py, a.x, a.y, a.x2, a.y2) < Math.max(8, a.width * 2)) return true;
      // 箭头头部命中：箭头不只是杆，点尖端附近也应能选中/拖动（旧实现只测杆，头附近点不中）。
      const headLen = Math.max(14, a.width * 4);
      const dx = a.x2 - a.x;
      const dy = a.y2 - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const vx = px - a.x2;
      const vy = py - a.y2;
      const proj = vx * ux + vy * uy; // 沿箭头方向距尖端的距离（负 = 往杆方向）
      const t = -proj; // 从尖端往后（进箭头头部）的深度，0=尖端，headLen=头底
      if (t >= -a.width && t <= headLen) {
        const perp = Math.abs(vx * -uy + vy * ux);
        // 头部是三角形：越靠近尖端越窄，头底半宽 ≈ headLen/2
        const maxPerp = (t <= 0 ? a.width : (t / headLen) * (headLen / 2)) + 2;
        if (perp <= maxPerp) return true;
      }
      return false;
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

/**
 * 该元素能不能被「点一下选中并拖动」。
 *
 * 遮罩类（马赛克 / 模糊）**不可选中**。两个理由，后一个才是重点：
 *   ① 笔刷型遮罩的命中容差是 `maskBrushWidth / 2`（笔宽 40 就是 20px），误命中面积很大 ——
 *     拿马赛克去涂第二块，碰到第一块就变成把第一块拖走，根本画不下去；
 *   ② **移动一块马赛克 = 把遮盖挪开 = 重新暴露刚遮住的隐私内容**。
 *     这不是误拖一个箭头那种代价，所以宁可不给移动能力。
 *
 * 遮罩仍然可删：Ctrl+Z 撤销、橡皮擦擦除（eraseStrokes 不走本函数，故不受影响）。
 *
 * ❗ 用「白名单」而不是反向排除：旧代码写的是 `if (tool !== "number")`，
 * 注释却声称“非绘制工具才命中”—— 两者对不上，而且每新增一个工具就自动落进可拖动集合。
 */
export function isSelectableAnnot(a: Annotation): boolean {
  return a.type !== "mosaic" && a.type !== "blur";
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

/** 键盘遍历方向 */
export type Dir = "left" | "right" | "up" | "down";

/**
 * 在控件清单里挑「指定方向上离 `from` 最近」的控件（纯几何）。
 *
 * 用于方向键遍历：主方向距离加权、垂直/水平偏移惩罚（×2.5），避免斜向远处的控件
 * 优先于正前方近处的控件。返回 null 表示那个方向没有候选（停在原地）。
 */
export function nearestInDirection(rects: Rect[], from: Rect, dir: Dir): Rect | null {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  let best: Rect | null = null;
  let bestScore = Infinity;
  for (const r of rects) {
    if (r === from) continue;
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const dx = c.x - fc.x;
    const dy = c.y - fc.y;
    let primary: number;
    let secondary: number;
    switch (dir) {
      case "right":
        if (dx <= 0) continue;
        primary = dx;
        secondary = Math.abs(dy);
        break;
      case "left":
        if (dx >= 0) continue;
        primary = -dx;
        secondary = Math.abs(dy);
        break;
      case "down":
        if (dy <= 0) continue;
        primary = dy;
        secondary = Math.abs(dx);
        break;
      case "up":
        if (dy >= 0) continue;
        primary = -dy;
        secondary = Math.abs(dx);
        break;
    }
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** 底图局部坐标矩形 → 屏幕坐标矩形（与 `toScreenPt` 同源，规则 11.1） */
export function toScreenRect(s: ScreenInfo | null, r: Rect): SnapRect {
  return { x: r.x + (s?.originX ?? 0), y: r.y + (s?.originY ?? 0), w: r.w, h: r.h };
}

/**
 * 把控件清单按「视觉阅读顺序」重排：先按行（中心 y 聚成行），行内按中心 x 升序。
 *
 * UIA 枚举返回的是控件树序——对 Chrome / Electron / VS Code 这类 App，树序和屏幕布局
 * 往往不一致，直接用它做 Tab 遍历会「乱跳」。按视觉位置排序后，Tab 变成「从左到右、
 * 从上到下」的可预测跳动，和方向键的「定向最近」互补。纯几何，零副作用。
 */
export function sortControlsVisual(rects: Rect[]): Rect[] {
  if (rects.length < 2) return rects.slice();
  const minH = rects.reduce((m, r) => Math.min(m, r.h), Infinity);
  const band = Math.max(minH * 0.6, 6); // 同一行的中心 y 允许偏差
  const byY = [...rects].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const rows: { rowY: number; items: Rect[] }[] = [];
  for (const r of byY) {
    const cy = r.y + r.h / 2;
    const hit = rows.find((row) => Math.abs(cy - row.rowY) <= band);
    if (hit) hit.items.push(r);
    else rows.push({ rowY: cy, items: [r] });
  }
  rows.sort((a, b) => a.rowY - b.rowY);
  const out: Rect[] = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2));
    out.push(...row.items);
  }
  return out;
}
