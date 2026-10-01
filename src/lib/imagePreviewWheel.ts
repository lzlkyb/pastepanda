/** 浮层里的滚轮留给面板及其子元素滚动，画布上的滚轮才缩放图片。 */
export function shouldZoomImageWheel(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest("[data-image-preview-overlay]"));
}
