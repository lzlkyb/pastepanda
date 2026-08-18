/**
 * 标注工具栏（主栏 + 属性条）的位置计算。
 *
 * 抽成纯函数的原因：旧实现写在 JSX 旁边且只算 top，水平全靠 CSS 的
 * `left: 50%` —— 意味着工具栏永远屏幕水平居中、不跟选区。在屏幕右上角
 * 框一小块时，工具栏飘在屏幕正中，鼠标要横穿半个屏幕（违反规则 17.2）。
 * 四种边界情况（下方放不下 / 上下都放不下 / 选区比工具栏窄 / 贴屏幕边缘）
 * 写在渲染函数里既读不懂也没法测，所以搬到这里并配单测。
 *
 * 坐标系：全部是 **CSS 像素**（调用方先用 css() 把物理像素选区换算好再传）。
 */

/** 工具栏与选区 / 屏幕边缘的间距 */
export const TB_GAP = 8;
/** 主栏与属性条之间的间距 */
export const TB_ATTR_GAP = 6;

/** 工具栏相对选区的附着方式（决定 tooltip 向上还是向下弹） */
export type TbAttach = "below" | "above" | "inside";

export interface TbRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TbLayout {
  /** 主栏左边缘 */
  left: number;
  /** 主栏顶边缘 */
  top: number;
  /** 属性条顶边缘（属性条与主栏左对齐，所以不再返回 left） */
  attrTop: number;
  attach: TbAttach;
}

/**
 * 算主栏与属性条的位置。
 *
 * 水平：右边缘对齐选区右边缘（微信 / QQ / Snipaste 都是这个规则），
 *       超出屏幕则向内钳；工具栏比屏幕还宽时至少保证左边可见。
 * 垂直：优先选区下方 → 放不下翻到上方 → 上下都放不下就贴选区内部底边。
 *       旧实现第三种情况直接 Math.max(8, ...) 钳到 top=8，会压在画面顶部。
 * 属性条：总是放在主栏的**远离选区一侧**，否则它会夹在工具栏和选区之间遮住画面。
 *
 * @param sel      选区（CSS 像素）
 * @param tbW      主栏宽
 * @param tbH      主栏高
 * @param attrH    属性条高（不显示时传 0）
 * @param vw / vh  视口尺寸
 */
export function layoutToolbar(
  sel: TbRect,
  tbW: number,
  tbH: number,
  attrH: number,
  vw: number,
  vh: number,
): TbLayout {
  // ---- 水平 ----
  // 选区比工具栏宽：右对齐选区右边缘（微信 / QQ / Snipaste 同款）。
  // 选区比工具栏窄：改为左对齐选区左边缘 —— 右对齐会把整条栏推到选区左侧很远的地方，
  // 鼠标从选区里出来要倒走一大段（窄选区是高频场景：框一个按钮、一行字）。
  let left = tbW <= sel.w ? sel.x + sel.w - tbW : sel.x;
  // 左越界：往右推（选区贴屏幕左边时造成）
  if (left < TB_GAP) left = TB_GAP;
  // 右越界。放在左越界之后才钳 —— 顺序决定了工具栏**宽于视口时哪一头被截**。
  //
  // 旧版顺序是反的，注释写着"宁可右边被截也要保住左边（左边是工具区）"。
  // 那在当时是对的：右端只有 取消 / 完成 / ⋯ 三个。现在右端是
  // 保存 / 贴图 / AI / 完成 / 更多 —— 全是出口，截掉它们等于这次截图没有去向，
  // 而左边被截掉的是橡皮擦之类的标注工具（还有 0-9 快捷键可用）。所以优先保右。
  if (left + tbW > vw - TB_GAP) left = vw - TB_GAP - tbW;

  // ---- 垂直 ----
  const totalH = attrH > 0 ? tbH + TB_ATTR_GAP + attrH : tbH;
  const belowTop = sel.y + sel.h + TB_GAP;
  const aboveTop = sel.y - TB_GAP - totalH;

  let top: number;
  let attach: TbAttach;
  if (belowTop + totalH <= vh - TB_GAP) {
    top = belowTop;
    attach = "below";
  } else if (aboveTop >= TB_GAP) {
    // 翻到上方：主栏在下、属性条在上（属性条靠外侧）
    top = sel.y - TB_GAP - tbH;
    attach = "above";
  } else {
    // 上下都放不下：贴选区内部底边，再钳回视口内
    top = sel.y + sel.h - TB_GAP - tbH;
    if (top + tbH > vh - TB_GAP) top = vh - TB_GAP - tbH;
    if (top < TB_GAP) top = TB_GAP;
    attach = "inside";
  }

  // 属性条：below 时在主栏下方；above / inside 时在主栏上方（远离选区一侧）
  const attrTop =
    attach === "below" ? top + tbH + TB_ATTR_GAP : top - TB_ATTR_GAP - attrH;

  return { left, top, attrTop, attach };
}

/**
 * OCR 选字模式胶囊（取代工具栏里的分段开关）的位置。
 *
 * 锚定选区**上缘右上角**：右对齐选区右边缘、上缘上方 8px。
 * 选区的上缘通常是大片遮罩死区，不压正在画的标注；但选区贴屏幕顶时
 * 上方放不下，就翻到上缘**内侧**；左右贴缘向里钳，规则与 layoutToolbar 同款。
 */
export function modePillPos(
  sel: TbRect,
  pillW: number,
  pillH: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  // ---- 水平：右对齐选区右边缘，越界向内钳 ----
  let left = sel.x + sel.w - pillW;
  if (left < TB_GAP) left = TB_GAP;
  if (left + pillW > vw - TB_GAP) left = vw - TB_GAP - pillW;

  // ---- 垂直：优先选区上方；放不下翻到上缘内侧 ----
  let top = sel.y - TB_GAP - pillH;
  if (top < TB_GAP) top = sel.y + TB_GAP;
  // 兜底：贴顶又很矮的选区里，翻到内侧仍可能超出视口，钳回
  if (top + pillH > vh - TB_GAP) top = vh - TB_GAP - pillH;

  return { left, top };
}
