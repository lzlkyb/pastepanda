/**
 * 选区尺寸标签（`宽 × 高` 那个小条）的竖向位置计算。
 *
 * 旧实现在 CSS 里写死 `bottom: -30px`，即“永远挂在选区下方 30px”。
 * 选区贴屏幕底部时那 30px 落在屏幕外，标签直接被裁掉——
 * 而它里面除了尺寸还写着“单击进标注 · 拖选区移动 · 拖边缘缩放”，
 * 是新用户唯一的操作提示，看不到影响很大。
 *
 * 与工具栏 / 侧边面板 / 状态小窗同一套做法：位置由纯函数算、配单测，
 * CSS 只管长相不管位置（见 toolbarPos.ts / panelPos.ts 的注释）。
 */

/** 标签高度（CSS 像素，与 .sel-size 的 padding + 字号对应） */
export const SIZE_LABEL_H = 26;
/** 标签与选区边缘的间距 */
export const SIZE_LABEL_GAP = 4;

export type SizeLabelPlace = "below" | "above" | "inside";

export interface SizeLabelLayout {
  /** 相对**选区左上角**的 top（标签是选区矩形的子元素） */
  top: number;
  place: SizeLabelPlace;
}

/**
 * 算尺寸标签的 top。
 *
 * 优先选区下方 → 放不下翻到上方 → 上下都放不下就贴选区内部顶部。
 * 与工具栏的三级回退保持一致，用户不需要学两套规则。
 *
 * 为什么第三级是“内部顶部”而不是“内部底部”：上下都放不下意味着选区
 * 几乎占满屏幕高度，而工具栏这时会贴在选区内部**底**边（见 layoutToolbar），
 * 标签跑顶部才不会和它撞。
 *
 * @param selTop  选区顶边（CSS 像素，视口坐标）
 * @param selH    选区高
 * @param vh      视口高
 */
export function layoutSizeLabel(selTop: number, selH: number, vh: number): SizeLabelLayout {
  const belowTop = selH + SIZE_LABEL_GAP;
  // 下方：标签底边不能超出视口
  if (selTop + belowTop + SIZE_LABEL_H <= vh) {
    return { top: belowTop, place: "below" };
  }
  // 上方：标签顶边不能超出视口顶部
  const aboveTop = -(SIZE_LABEL_H + SIZE_LABEL_GAP);
  if (selTop + aboveTop >= 0) {
    return { top: aboveTop, place: "above" };
  }
  return { top: SIZE_LABEL_GAP, place: "inside" };
}
