/**
 * 长截图拼接的纯计算：重叠行匹配与帧稳定性判断。
 *
 * 为什么拆成「数据版 + canvas 版」两层：
 * 原实现 findOverlapRows 直接收 HTMLCanvasElement，内部 createElement + getContext + getImageData——
 * jsdom 里 getContext("2d") 返回 null，整个函数根本没法单测。
 * 而它里面藏过一个真 bug（G/B 两个通道拿 prev 的行偏移去索引 next，三分之二的匹配信号
 * 退化成噪声，导致拼接接缝错位），正是需要回归测试钉住的地方。
 * 拆出 `overlapRowsFromData` 后，匹配逻辑变成纯数组运算，可以直接造数据断言。
 */

/** 重叠匹配前的统一缩放宽度（内容特征保留、计算量可控） */
export const STITCH_PROBE_W = 240;

/** 全局变化阈值：平均通道差小于它 → 视为画面没动 */
export const GLOBAL_DIFF_T = 5;
/** 行匹配阈值：平均通道差小于它 → 视为这 k 行重叠 */
export const ROW_MATCH_T = 6;

/**
 * 两帧是否「几乎一样」（= 渲染已经稳定）。
 * 判据与下方重叠匹配里的全局变化检测同源（同一个 GLOBAL_DIFF_T），
 * 不另写一套阈值（规则 11.1）。
 */
export function framesAlike(a: ImageData, b: ImageData): boolean {
  if (a.data.length !== b.data.length) return false;
  return globalDiff(a.data, b.data) < GLOBAL_DIFF_T;
}

/** 两块 RGBA 数据的平均通道差（每 16 字节采样一次）。长度不等时返回 Infinity。 */
export function globalDiff(d1: Uint8ClampedArray, d2: Uint8ClampedArray): number {
  if (d1.length !== d2.length || d1.length === 0) return Number.POSITIVE_INFINITY;
  let diff = 0;
  let cnt = 0;
  for (let i = 0; i < d1.length; i += 16) {
    diff += Math.abs(d1[i] - d2[i]);
    cnt++;
  }
  return cnt === 0 ? Number.POSITIVE_INFINITY : diff / cnt;
}

/**
 * 重叠行匹配（纯数据版，可单测）：返回 next 顶部与 prev 底部重叠的**原图**像素行数。
 *
 * @param d1    prev 帧缩放后的 RGBA 数据（W × sh）
 * @param d2    next 帧缩放后的 RGBA 数据（同尺寸）
 * @param W     缩放后宽度
 * @param sh    缩放后高度
 * @param scale 缩放比 = W / 原图宽，用于把小图行数换算回原图行数
 * @returns 重叠行数；0 表示“画面未变化 / 未找到重叠”
 */
export function overlapRowsFromData(
  d1: Uint8ClampedArray,
  d2: Uint8ClampedArray,
  W: number,
  sh: number,
  scale: number,
): number {
  // 全局变化检测：几乎未变 → 视为滚动到底 / 内容静止
  if (globalDiff(d1, d2) < GLOBAL_DIFF_T) return 0;

  const maxK = Math.min(Math.floor(sh * 0.6), 90);
  for (let k = maxK; k >= 3; k--) {
    let diff = 0;
    let cnt = 0;
    for (let row = 0; row < k; row++) {
      const pr = (sh - k + row) * W * 4; // prev 底部第 row 行
      const nr = row * W * 4; // next 顶部第 row 行
      for (let col = 0; col < W; col += 2) {
        const i1 = pr + col * 4;
        const i2 = nr + col * 4;
        // ⚠️ 三个通道都必须用 next 自己的行偏移 i2。
        // 原实现 G/B 两项写成了 d2[i1+1]/d2[i1+2]，拿 prev 的行偏移去索引 next，
        // 比出来的是「同一位置两帧之差」而不是「错位 k 行的匹配度」，
        // 三分之二的信号退化成噪声 → 重叠行数算错 → 长图接缝错位/内容重复或丢失。
        diff +=
          Math.abs(d1[i1] - d2[i2]) +
          Math.abs(d1[i1 + 1] - d2[i2 + 1]) +
          Math.abs(d1[i1 + 2] - d2[i2 + 2]);
        cnt += 3;
      }
    }
    if (cnt > 0 && diff / cnt < ROW_MATCH_T) return Math.max(2, Math.round(k / scale));
  }
  return 0;
}

/**
 * 重叠行匹配（canvas 版）：把两张图缩到 STITCH_PROBE_W 宽再交给 {@link overlapRowsFromData}。
 * 取样这一步依赖真实 canvas，jsdom 下不可用，所以单测只针对数据版。
 */
export function findOverlapRows(
  prev: HTMLCanvasElement,
  next: HTMLCanvasElement,
  w: number,
  h: number,
): number {
  const W = STITCH_PROBE_W;
  const scale = W / w;
  const sh = Math.max(4, Math.round(h * scale));
  const toSmall = (src: HTMLCanvasElement) => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = sh;
    const x = c.getContext("2d", { willReadFrequently: true });
    if (!x) return null;
    x.drawImage(src, 0, 0, W, sh);
    return x.getImageData(0, 0, W, sh).data;
  };
  const d1 = toSmall(prev);
  const d2 = toSmall(next);
  if (!d1 || !d2) return 0;
  return overlapRowsFromData(d1, d2, W, sh, scale);
}
