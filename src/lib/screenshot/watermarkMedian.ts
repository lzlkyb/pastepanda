/**
 * 去水印（空间域「中值叠瓦」路线）—— 替代 dewarp.ts 的频域减回。
 *
 * 为什么换路线：频域减回是「全局线性加性」模型，有两个绕不开的硬伤：
 *   1) 误伤/发花 —— 聊天行、面板网格这些**周期性内容**在频域跟水印同样成峰，
 *      峰门控（keepPeaks）分不清，于是把内容当水印减掉 → 发花。
 *   2) 去不干净 —— 真实水印是 alpha 混合（浅底上看得见、深底上几乎不可见），
 *      频域只估得到 α·(W−O) 这种均匀加性残差，减回时深色区欠减、浅色区过减。
 *
 * 空间域中值叠瓦（本文件）的核心思想：
 *   水印是**逐瓦片完全相同**的（周期 Tx×Ty），而内容**逐瓦片不同**。
 *   对同一个瓦片内偏移 (ox,oy)，跨所有瓦片取中值 → 内容被中值抵消、水印被保留，
 *   直接估出真实水印调制层 M。再减掉这个调制层即去水印，且**绝不误伤内容**
 *   （内容不周期，根本进不了 M）。公式层面甚至不需要估 α：
 *      M(offset) = (1−α)·Q(offset) + α·W(offset)   （Q=内容跨瓦片中值）
 *      O_est = I − (M − bg) 会把 W 项精确抵消，只留下 (1−α)O 轻微向背景压暗 —— 无发花。
 *
 * 纯像素函数、无 DOM、无 canvas，可在 Node / jsdom 下单测。复用 dewarp.ts 导出的
 * downsampleGray 与 fft1d（自相关周期估计）。离线、不触 ai_enabled。
 *
 * 这是「先探针验证」阶段的核心算法，验证有效后再在 removeTiledWatermarkRegion
 * 处接入（届时 dewarp.ts 退化为统一入口）。
 */

import { downsampleGray, fft1d } from "./dewarp";

export interface Period {
  /** 瓦片周期（原始像素），x 方向 */
  tx: number;
  /** 瓦片周期（原始像素），y 方向 */
  ty: number;
  /** 自相关峰相对 DC 的归一化强度（0~1），用于判断「是否存在可信周期」 */
  score: number;
}

/** 取 ≤ cap 的最大 2 的幂（FFT 要求 2 的幂）。 */
function pow2le(n: number, cap: number): number {
  let s = Math.min(cap, n);
  if (s < 2) s = 2;
  let p = 1;
  while (p * 2 <= s) p <<= 1;
  return Math.max(2, p);
}

/** 2D FFT（行先后列），re/im 原地修改，size 为 2 的幂。 */
function fft2d(re: Float64Array, im: Float64Array, size: number): void {
  for (let y = 0; y < size; y++) {
    fft1d(re.subarray(y * size, y * size + size), im.subarray(y * size, y * size + size));
  }
  const colRe = new Float64Array(size);
  const colIm = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      colRe[y] = re[y * size + x];
      colIm[y] = im[y * size + x];
    }
    fft1d(colRe, colIm);
    for (let y = 0; y < size; y++) {
      re[y * size + x] = colRe[y];
      im[y * size + x] = colIm[y];
    }
  }
}

/** 2D IFFT（共轭 FFT / N），re/im 原地修改。 */
function ifft2d(re: Float64Array, im: Float64Array, size: number): void {
  for (let i = 0; i < size * size; i++) im[i] = -im[i];
  fft2d(re, im, size);
  const inv = 1 / (size * size);
  for (let i = 0; i < size * size; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

/**
 * 估计平铺水印周期（空间域自相关）。
 *
 * 思路：亮度图降采样到 S×S（2 的幂）→ 去均值 → 2D FFT → 功率谱 |F|² → 2D IFFT
 * 得自相关（Wiener–Khinchin）。水印的全局周期会在自相关上打出一个远离原点的尖峰；
 * 内容不周期，只会贡献弥散底噪。在「合理瓦片尺寸」带内取最强峰即周期。
 *
 * @returns 周期与置信度；若带内无显著峰（score 过低）返回 null —— 调用方应退回 inpaint。
 */
export function estimateWatermarkPeriod(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): Period | null {
  const S = pow2le(Math.min(w, h), 256);
  const ds = downsampleGray(rgba, w, h, S); // 降采样到宽 ≤S，高等比
  // downsampleGray 返回的是不等比降采样，这里再最近邻压成 S×S 方阵
  const lum = new Float64Array(S * S);
  const gw = ds.w;
  const gh = ds.h;
  let mean = 0;
  for (let y = 0; y < S; y++) {
    const sy = Math.min(gh - 1, Math.floor(((y + 0.5) / S) * gh));
    for (let x = 0; x < S; x++) {
      const sx = Math.min(gw - 1, Math.floor(((x + 0.5) / S) * gw));
      const v = ds.gray[sy * gw + sx];
      lum[y * S + x] = v;
      mean += v;
    }
  }
  mean /= S * S;
  for (let i = 0; i < S * S; i++) lum[i] -= mean;

  // 去趋势：减去行列均值（消除光照渐变这类低频背景）。背景能量远大于水印，
  // 若不去除，自相关峰被 DC 淹没。水印是「中频周期」、文字是「高频 aperiodic」，
  // 去趋势只动低频，二者都保留；而文字 aperiodic 不会产生瓦片周期峰。
  {
    const rowMean = new Float64Array(S);
    const colMean = new Float64Array(S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) rowMean[y] += lum[y * S + x];
      rowMean[y] /= S;
    }
    for (let x = 0; x < S; x++) {
      for (let y = 0; y < S; y++) colMean[x] += lum[y * S + x];
      colMean[x] /= S;
    }
    let g = 0;
    for (let y = 0; y < S; y++) g += rowMean[y];
    g /= S;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        lum[y * S + x] -= rowMean[y] + colMean[x] - g;
      }
    }
  }

  // 自相关 = IFFT(|FFT(lum)|²)
  const re = Float64Array.from(lum);
  const im = new Float64Array(S * S);
  fft2d(re, im, S);
  for (let i = 0; i < S * S; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    re[i] = p;
    im[i] = 0;
  }
  ifft2d(re, im, S); // re 现在即自相关（实部）

  // ── 两遍扫描 ──
  // 第①遍：找「最强局部极大峰」用于**置信度**判定。水印周期会在多个谐波处都成峰
  // （tx, 2tx, 3tx… 及混合谐波），且因水印墨块边缘锐利，高频谐波的自相关峰甚至可能
  // 比基频更高（探针实测：基频 lag(32,32) score .113，混合谐波 lag(64,96) .148）。
  // 但内容 aperiodic、背景已去趋势，二者都不会产生「带内显著峰」，故用最强峰 score
  // 区分「有水印 vs 纯内容」（纯内容最强峰远低于水印）。
  // 第②遍：在「所有局部极大峰」里取 **lag 最小**者作为周期。谐波是基频的整数倍必更大，
  // 瓦片周期才是最小周期；内容无周期、背景已去趋势，都不会产生「带内最小 lag 的显著峰」。
  const MIN_PX = 48; // 小于此视为噪声/纹理，不算瓦片
  const lagMin = Math.max(2, Math.ceil((MIN_PX / w) * S));
  const lagMax = Math.floor(S / 2) - 2;
  const dc = Math.abs(re[0]);

  interface Cand { lx: number; ly: number; val: number; }
  const cands: Cand[] = [];
  let strongest = 0;
  let sx = 0;
  let sy = 0;
  for (let ly = lagMin; ly <= lagMax; ly++) {
    for (let lx = lagMin; lx <= lagMax; lx++) {
      const c = re[ly * S + lx];
      // 局部极大：严格大于四邻（自相关对称，只搜第一象限）
      if (
        c > re[ly * S + (lx - 1)] &&
        c > re[ly * S + (lx + 1)] &&
        c > re[(ly - 1) * S + lx] &&
        c > re[(ly + 1) * S + lx]
      ) {
        cands.push({ lx, ly, val: c });
        if (c > strongest) {
          strongest = c;
          sx = lx;
          sy = ly;
        }
      }
    }
  }
  const score = dc > 0 ? strongest / dc : 0;
  // 置信门槛：最强峰至少要达到 DC 的一定比例才算「存在可信周期」
  // （内容弥散底噪远低于此）。不满足则退回 inpaint。
  if (score < 0.08 || sx === 0 || sy === 0) return null;

  // 基频 = lag 最小且仍显著的候选（谐波必更大，故最小 lag 即瓦片周期）
  const FUND_THRESH = 0.05;
  const scoreOf = (v: number) => (dc > 0 ? v / dc : 0);
  const strong = cands.filter((c) => scoreOf(c.val) >= FUND_THRESH);
  if (strong.length === 0) return null;
  strong.sort((a, b) => Math.hypot(a.lx, a.ly) - Math.hypot(b.lx, b.ly));
  const f = strong[0];
  return {
    tx: Math.round((f.lx / S) * w),
    ty: Math.round((f.ly / S) * h),
    score,
  };
}

/**
 * 中值叠瓦：估出真实水印调制层 M（与输入同尺寸，w*h）。
 *
 * 把图切成 Tx×Ty 的瓦片网格，对每个偏移 (ox,oy)∈[0,Tx)×[0,Ty)，跨所有**完整**瓦片
 * 取中值。内容逐瓦片不同→中值抵消；水印逐瓦片相同→保留。返回 M（含中性背景，未减 bg）。
 *
 * 注意相位：所有瓦片原点相差 Tx/Ty 的整数倍，水印周期恰为 Tx/Ty，故每个瓦片内同一
 * 偏移对应的水印相位**完全相同**——中值天然对齐，无需显式配准。
 */
export function estimateWatermarkLayerMedian(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  tx: number,
  ty: number,
): Float64Array {
  const N = w * h;
  const M = new Float64Array(N * 4); // 4 通道：索引 p*4+c
  // 每个通道独立求中值（水印可能是单色叠加，但保留彩色保真）
  for (let c = 0; c < 3; c++) {
    const buckets: number[][] = new Array(tx * ty);
    for (let k = 0; k < buckets.length; k++) buckets[k] = [];
    // 收集所有完整瓦片在该偏移的像素
    for (let ty0 = 0; ty0 + ty <= h; ty0 += ty) {
      for (let tx0 = 0; tx0 + tx <= w; tx0 += tx) {
        for (let oy = 0; oy < ty; oy++) {
          const yy = ty0 + oy;
          const rowBase = yy * w;
          for (let ox = 0; ox < tx; ox++) {
            const xx = tx0 + ox;
            const v = rgba[(rowBase + xx) * 4 + c];
            buckets[oy * tx + ox].push(v);
          }
        }
      }
    }
    // 每偏移取中值写入 M
    for (let k = 0; k < buckets.length; k++) {
      const arr = buckets[k];
      if (arr.length === 0) continue;
      arr.sort((a, b) => a - b);
      const med = arr[arr.length >> 1];
      const ox = k % tx;
      const oy = (k / tx) | 0;
      // 把该偏移的中值铺回所有瓦片对应位置（含边缘不完整瓦片，用最近瓦片相位近似）
      for (let ty0 = 0; ty0 < h; ty0 += ty) {
        const yy = ty0 + oy;
        if (yy >= h) continue;
        const rowBase = yy * w;
        for (let tx0 = 0; tx0 < w; tx0 += tx) {
          const xx = tx0 + ox;
          if (xx >= w) continue;
          M[(rowBase + xx) * 4 + c] = med;
        }
      }
    }
  }
  // alpha 通道原样（水印不改透明度）
  for (let i = 0; i < N; i++) M[i * 4 + 3] = rgba[i * 4 + 3];
  return M;
}

/**
 * 分离式 box blur（水平 + 垂直各一遍），用于把中值层里的「缓慢背景 Q」与「周期水印 W」
 * 分开。半径必须远大于瓦片尺寸，才能把周期 W 平均成常数 W0、同时保留缓慢变化的 Q。
 */
/**
 * 分离式 box blur（水平半径 rx、垂直半径 ry 各自独立）。
 *
 * 用**前缀和**实现 O(1) 每像素（窗口越大越快相对朴素滑窗），否则 rx/ry 取 3·瓦片
 * （数百像素）时复杂度 O(N·r) 会让大图跑几十秒。窗口半径远大于瓦片才能把周期水印 W
 * 抹平为常数、同时保留缓慢背景 Q。
 */
function boxBlurSep(
  src: Float64Array,
  w: number,
  h: number,
  rx: number,
  ry: number,
): Float64Array {
  const xr = Math.max(0, Math.round(rx));
  const yr = Math.max(0, Math.round(ry));
  if (xr < 1 && yr < 1) return Float64Array.from(src);
  const N = w * h;
  const tmp = new Float64Array(N * 4);
  const out = new Float64Array(N * 4);
  for (let c = 0; c < 3; c++) {
    // 水平：前缀和滑窗
    for (let y = 0; y < h; y++) {
      const rowBase = y * w;
      const pref = new Float64Array(w + 1);
      for (let x = 0; x < w; x++) pref[x + 1] = pref[x] + src[(rowBase + x) * 4 + c];
      for (let x = 0; x < w; x++) {
        const lo = Math.max(0, x - xr);
        const hi = Math.min(w - 1, x + xr);
        const sum = pref[hi + 1] - pref[lo];
        tmp[(rowBase + x) * 4 + c] = sum / (hi - lo + 1);
      }
    }
    // 垂直：前缀和滑窗
    for (let x = 0; x < w; x++) {
      const pref = new Float64Array(h + 1);
      for (let y = 0; y < h; y++) pref[y + 1] = pref[y] + tmp[(y * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        const lo = Math.max(0, y - yr);
        const hi = Math.min(h - 1, y + yr);
        const sum = pref[hi + 1] - pref[lo];
        out[(y * w + x) * 4 + c] = sum / (hi - lo + 1);
      }
    }
  }
  return out;
}

/**
 * 中值叠瓦去水印主入口（平铺模式）。原地修改 rgba。
 *
 * 还原公式（详见文件头推导）：O_est = I − (M − smoothM)。
 *   · M = 中值叠瓦层 = (1−α)Q + αW（Q=内容跨瓦片中值，W=水印）
 *   · smoothM = 对 M 做「远大于瓦片」的平滑 = (1−α)Q + α·W0（周期 W 被抹平为常数 W0）
 *   · 相减 → M − smoothM = α(W − W0)，**恰好是纯水印调制项**（Q 项被抵消）
 *   → 减回去后水印模式精确消失，只留下 (1−α)O + αW0（朝中性灰的统一轻微染色，
 *     绝非按偏移变化的压暗/提亮，因此**不发花、不误伤内容**）。
 *
 * ❗ 用全局中值当 bg 是错的：背景 Q 随偏移缓慢变化，减全局 bg 会把 Q 一起减掉 → 发花。
 *    必须用局部平滑（半径>>瓦片）得到 smoothM，只剔周期项。
 *
 * @returns true 表示估到可信周期并执行；false 表示无周期（调用方应退回 inpaint 兜底）。
 */
export function removeWatermarkByTiling(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  period: Period | null,
): boolean {
  let tx = period?.tx ?? 0;
  let ty = period?.ty ?? 0;
  // 周期太小（<8px）或无周期 → 不值得/不可信，退回 inpaint
  if (tx < 8 || ty < 8) return false;
  // 周期超过图像一半没有意义（瓦片数<2，中值退化为原图）
  tx = Math.min(tx, Math.floor(w / 2));
  ty = Math.min(ty, Math.floor(h / 2));
  if (tx < 8 || ty < 8) return false;

  const M = estimateWatermarkLayerMedian(rgba, w, h, tx, ty);
  // 平滑窗口取「整数倍瓦片周期」：水平 3·tx、垂直 3·ty。这样每个方向恰好平均掉
  // 整数个周期的水印 W（blurW → 常数 W₀），同时窗口 << 图像尺寸、保留缓慢变化的 Q。
  // ❗ 之前用 R=max(tx,ty)+2（≈周期），窗口只覆盖 ~2 个周期且非整数倍 → W 抹不净、
  //    sinc 涟漪泄漏进 (M−S) 与 (W−W₀) 相关，残留 watermarkCorr≈0.12。放大到 3 倍整数
  //    周期后 W 被精确平均，残留应降到 0.05 量级。
  const rx = 3 * tx;
  const ry = 3 * ty;
  const S = boxBlurSep(M, w, h, rx, ry);

  const N = w * h;
  for (let i = 0; i < N; i++) {
    const ii = i * 4;
    // 减掉纯水印调制项 (M − S)；三通道各自独立
    rgba[ii] = rgba[ii] - (M[ii] - S[ii]);
    rgba[ii + 1] = rgba[ii + 1] - (M[ii + 1] - S[ii + 1]);
    rgba[ii + 2] = rgba[ii + 2] - (M[ii + 2] - S[ii + 2]);
  }
  return true;
}
