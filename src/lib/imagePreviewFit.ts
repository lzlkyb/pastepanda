/** 图片查看层以原图像素为坐标系；只改变容器缩放，OCR 词框与图片保持同步。 */
export function imageFitScale(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  rotation: number,
): number {
  if (imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return 1;
  const sideways = ((rotation % 180) + 180) % 180 === 90;
  const width = sideways ? imageHeight : imageWidth;
  const height = sideways ? imageWidth : imageHeight;
  // 两侧各留 12px，避免图片紧贴查看区边缘；小图不强行放大。
  return Math.min(1, Math.max(1, viewportWidth - 24) / width, Math.max(1, viewportHeight - 24) / height);
}

/** 缩小下限必须低于当前适应比例，超大图在 550px 窗口里可能只有几个百分点。 */
export function clampImageZoom(scale: number, fitScale: number): number {
  return Math.max(Math.min(0.02, fitScale), Math.min(5, scale));
}
