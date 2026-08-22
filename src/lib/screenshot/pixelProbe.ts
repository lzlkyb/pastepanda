/**
 * 底图 1×1 取色探针 —— 放大镜与吸管共用的唯一实现。
 *
 * 为什么要收口：这两个入口原本各写一遍采样，口径还不一致 ——
 *   吸管（annotate 态点画布）：先 clearRect、alpha=0 时返回 null、hex **大写**；
 *   放大镜（select 态拖选）：不 clear、不判 alpha、hex **小写**。
 * 于是同一张图同一个像素，复制出来的色值取决于用户从哪个入口进；而"不 clearRect"在
 * 采到透明像素时还会读出**上一次**的颜色（探针 canvas 是模块级复用的）。
 *
 * 现在两边都走这里：clearRect + 判 alpha + 大写 hex。
 */

/** 取色探针 canvas。模块级复用 —— 拖选是高频路径，每次 createElement 会造成明显 GC 压力。 */
let probeCanvas: HTMLCanvasElement | null = null;

export interface SampledPixel {
  /** 大写十六进制色值，形如 #AABBCC */
  hex: string;
  r: number;
  g: number;
  b: number;
}

/**
 * 在底图的 (sx, sy) 处取一个像素。
 *
 * @param base 已加载完成的底图
 * @param sx   底图坐标（物理像素，可为小数，内部取整）
 * @param sy   同上
 * @returns    取不到（canvas 不可用 / 像素全透明）时返回 null，调用方据此不更新色值
 */
export function samplePixelHex(
  base: HTMLImageElement,
  sx: number,
  sy: number,
): SampledPixel | null {
  if (!probeCanvas) probeCanvas = document.createElement("canvas");
  const ctx = probeCanvas.getContext("2d");
  if (!ctx) return null;
  // 必须先清：探针是复用的，采到透明像素时不清会读出上一次的颜色
  ctx.clearRect(0, 0, 1, 1);
  ctx.drawImage(base, Math.floor(sx), Math.floor(sy), 1, 1, 0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  if (d[3] === 0) return null;
  const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return { hex, r: d[0], g: d[1], b: d[2] };
}
