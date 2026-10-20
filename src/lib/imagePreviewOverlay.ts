/**
 * 图片详情浮层（OCR 面板 / 导出 / 码面板）与图片画布同处一个 viewport，
 * 且浮层根节点只 `pointer-events: none` 让位、面板本身是 `auto`：
 * 面板内的事件照样会冒泡到 viewport 的滚轮与按下处理器。
 *
 * 所以「这个目标归不归画布」必须有两处统一判定：
 * - 滚轮：`shouldZoomImageWheel` —— 面板里的滚动留给面板自己；
 * - 按下：`handleOcrSelectStart` —— 面板里的按下不是框选起手。
 *   不判定就会在 mousedown 里 `setSelectedWordIndices(new Set())` 把已选词清空，
 *   紧接着按钮因 `size === 0` 变灰、click 不派发 ⇒ 点「复制选中」等于没点。
 */
export function isInsidePreviewOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-image-preview-overlay]") !== null;
}
