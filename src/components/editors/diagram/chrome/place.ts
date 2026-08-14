/**
 * 浮层定位的纯函数（属性浮岛 / 右键菜单共用一套钳制）。
 *
 * 抽成纯函数是为了能测：边界翻面与钳制算错了不会报错，只是浮层静悄悄跑到画布外
 * 或者尖角指不准，靠肉眼很容易漏。
 *
 * 坐标全部是**容器坐标**（相对 .root 的左上角），不是 flow 坐标也不是屏幕坐标。
 */

/** 浮层距容器边缘的最小留白 */
export const EDGE_MARGIN = 8;
/** 浮岛与锚定节点之间的间隙（留给小尖角） */
export const ANCHOR_GAP = 10;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** true = 摆在锚点下方（上方放不下时），组件靠它把小尖角翻到顶边 */
  below: boolean;
}

function clamp(v: number, min: number, max: number): number {
  // max < min 是容器比浮层还小的退化情况（窗口拉到 minWidth），
  // 此时让它贴左上角而不是返回一个比 min 还小的值
  if (max < min) return min;
  return Math.min(Math.max(v, min), max);
}

/**
 * 把浮岛摆到锚定矩形（选中节点）的上方，上方放不下则翻到下方，水平居中并钳制。
 */
export function placeAnchored(anchor: Rect, size: Size, container: Size): Placement {
  const above = anchor.top - size.height - ANCHOR_GAP;
  const below = above < EDGE_MARGIN;
  const rawTop = below ? anchor.top + anchor.height + ANCHOR_GAP : above;
  const rawLeft = anchor.left + anchor.width / 2 - size.width / 2;
  return {
    left: clamp(rawLeft, EDGE_MARGIN, container.width - size.width - EDGE_MARGIN),
    // 翻到下方后仍可能出底（节点就在画布底部），所以竖向也要再钳一道
    top: clamp(rawTop, EDGE_MARGIN, container.height - size.height - EDGE_MARGIN),
    below,
  };
}

/**
 * 把菜单摆在鼠标点右下，越界时向左/向上翻（而不是硬贴边）。
 *
 * 向左翻而不是贴右边：贴边会让菜单盖住鼠标下方的内容，而用户刚右键的就是那个位置。
 */
export function placeMenu(point: { x: number; y: number }, size: Size, container: Size): { left: number; top: number } {
  const flipX = point.x + size.width > container.width - EDGE_MARGIN;
  const flipY = point.y + size.height > container.height - EDGE_MARGIN;
  return {
    left: clamp(flipX ? point.x - size.width : point.x, EDGE_MARGIN, container.width - size.width - EDGE_MARGIN),
    top: clamp(flipY ? point.y - size.height : point.y, EDGE_MARGIN, container.height - size.height - EDGE_MARGIN),
  };
}
