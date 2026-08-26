/**
 * 斜向水印中值叠瓦。
 *
 * 企业微信/钉钉/飞书的 screenshot 防泄露水印有两种常见形态：
 *   · 轴对齐平铺 logo/网格  →  watermarkMedian.ts 的 removeWatermarkByTiling
 *   · 斜向重复文字（一行行斜着排） →  本文件的 removeDiagonalWatermarkByTiling
 *
 * 斜向水印模型：W(y,x) = P( (x + a·y) mod Tx )，即每行相对上一行水平平移 a 像素、
 * 每行内部以 Tx 为水平周期重复。视觉上形成从左上到右下的斜向条纹。
 *
 * 去除思路（与轴对齐同款原理）：
 *   1) 剪切 x'' = x + a·y（采样原图 (x'' − a·y, y)），把斜向周期掰成「纯水平周期」
 *      W'(x'') = P(x'' mod Tx)，与水印方向无关了；
 *   2) 水平相位中值：**逐行**取「行内间距 Tx 的同相位采样」的中值，即 M'(y,p) =
 *      median{ sheared[y][x] : x ≡ p (mod Tx) }。同一行内同相位的各采样点空间上相距
 *      Tx、内容 aperiodic 稀疏 → 中值落在背景水平；水印 P(p) 逐点相同 → 被保留。
 *      （注意不是跨 y 取中值——跨 y 需要行间配准，这里靠剪切已把相位对齐到行内。）
 *   3) 对 M' 沿 x'' 做「整数倍 Tx」的 box blur 抹平周期项、保留缓慢背景；
 *   4) 相减 O_est = I' − (M' − smoothM') 即去除 α(W−W0) 调制项；最后逆剪切恢复。
 *
 * 周期估计（estimateObliqueWatermark）：用「剪切扫描」——对候选斜率 a，剪切后若 a 正确，
 * 各行变成同一份 P(x'') 的平移 → 沿行求平均得到干净的 P，其 1D 自相关峰（lag=Tx）最强；
 * 最大化该峰强度即得正确 a 与 Tx。比 2D 自相关峰拾取稳健得多（斜向在 2D 上是山脊非孤立峰）。
 *
 * 纯像素函数、无 DOM，可在 Node / jsdom 下单测。
 */

import { downsampleGray, fft1d } from "./dewarp";

export interface ObliquePeriod {
  /** 水平周期（原始像素） */
  tx: number;
  /** 剪切斜率 a（每向下一行，水印水平平移 a 像素） */
  shearK: number;
  /** 最佳自相关峰强度（0~1），用于判断「是否存在可信斜向周期」 */
  score: number;
}

/** 取 ≥ n 的最小 2 的幂。 */
function pow2ge(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 1D 自相关（返回实部数组，长度 = 下一个 2 的幂；仅 [0, N/2) 有效）。 */
function autocorr1d(sig: Float64Array): { ac: Float64Array; dc: number } {
  const n = sig.length;
  const N = pow2ge(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  re.set(sig);
  fft1d(re, im);
  for (let i = 0; i < N; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    re[i] = p;
    im[i] = 0;
  }
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft1d(re, im);
  const inv = 1 / N;
  for (let i = 0; i < N; i++) re[i] = re[i] * inv;
  return { ac: re, dc: Math.abs(re[0]) };
}

/**
 * 在 [lagMin, lagMax] 内挑「基频」lag。
 *
 * 不能简单取最小局部极大：水印图案若在周期内含 N 段相同墨带（如合成图双墨带），自相关会在
 * 周期/2、周期/3 处也成峰，被误当基频。真正基频的特征是**谐波相干**——其 2L、3L、4L 处
 * 自相关也强。故对每个候选局部极大 L，算相干度 = mean(ac[L],ac[2L],ac[3L],ac[4L])/dc，
 * 取相干度最高者（并列取最小 lag）。内容/背景经高通后无带内周期峰，不会入选。
 */
/** 基频 lag + 谐波相干度（相干度用于存在性判据）。 */
interface FundResult {
  lag: number;
  /** 谐波相干度 = mean(ac[L],ac[2L],ac[3L],ac[4L]) / dc。真实周期水印下显著 >0；
   *  纯噪声/内容无谐波结构，相干度≈噪声波动（<0.05），可借此拒识。 */
  coherence: number;
}

function fundamentalLag(
  ac: Float64Array,
  lagMin: number,
  lagMax: number,
  dc: number,
): FundResult {
  const hi = Math.min(lagMax, Math.floor(ac.length / 2) - 1);
  const lo = Math.max(1, lagMin);
  const cands: number[] = [];
  for (let k = lo; k <= hi; k++) {
    if (ac[k] > ac[k - 1] && ac[k] >= ac[k + 1]) cands.push(k);
  }
  if (cands.length === 0) return { lag: lo, coherence: 0 };
  let bestL = cands[0];
  let bestScore = -1;
  for (const L of cands) {
    let s = 0;
    let cnt = 0;
    for (let m = 1; m <= 4; m++) {
      const idx = Math.round(L * m);
      if (idx <= hi) {
        s += ac[idx];
        cnt++;
      }
    }
    const score = cnt > 0 ? s / cnt / (dc + 1e-12) : 0;
    if (score > bestScore || (Math.abs(score - bestScore) < 1e-9 && L < bestL)) {
      bestScore = score;
      bestL = L;
    }
  }
  return { lag: bestL, coherence: bestScore };
}

/** 1D 高通：减去大窗口滑动平均，去掉低频背景（光照渐变/平滑区），突出周期项。 */
function highpass(sig: Float64Array, win: number): Float64Array {
  const n = sig.length;
  const out = new Float64Array(n);
  const r = Math.max(1, win >> 1);
  const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + sig[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    out[i] = sig[i] - (pref[hi + 1] - pref[lo]) / (hi - lo + 1);
  }
  return out;
}

/**
 * 估计斜向水印的水平周期 Tx 与剪切斜率 a。找不到可信周期返回 null（调用方退回 inpaint）。
 *
 * 思路（剪切扫描）：对候选斜率 a，做剪切 sheared[y][x]=lum[y][(x−a·y) mod GW]。若干 a 正确，
 * 各行变为同一份水平周期图案 P 的平移 → 沿行平均得干净的 P，其 1D 自相关在 lag=Tx_ds 处成峰。
 * 但背景平滑会在 lag=1 处产生极强相关、淹没周期峰，故先对 meanRow 高通（去低频背景）再找
 * [lagMin,lagMax] 带内峰。最大化带内峰强度即得正确 a 与 Tx。
 */
export function estimateObliqueWatermark(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): ObliquePeriod | null {
  const S = 256; // 降采样目标宽
  const ds = downsampleGray(rgba, w, h, S);
  const GW = ds.w;
  const GH = ds.h;
  const lum = new Float64Array(GW * GH);
  let mean = 0;
  // downsampleGray 已按目标宽输出，这里直接平铺；不做二次重采样（旧写法的
  // ((y+0.5)/GH)*GH 映射恒等于 y，是恒等运算死代码）。
  for (let i = 0; i < GW * GH; i++) {
    const v = ds.gray[i];
    lum[i] = v;
    mean += v;
  }
  mean /= GW * GH;
  for (let i = 0; i < GW * GH; i++) lum[i] -= mean;
  // 行列式去趋势（消光照渐变）
  const rowMean = new Float64Array(GH);
  const colMean = new Float64Array(GW);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) rowMean[y] += lum[y * GW + x];
  for (let y = 0; y < GH; y++) rowMean[y] /= GW;
  for (let x = 0; x < GW; x++) for (let y = 0; y < GH; y++) colMean[x] += lum[y * GW + x];
  for (let x = 0; x < GW; x++) colMean[x] /= GH;
  let g = 0;
  for (let y = 0; y < GH; y++) g += rowMean[y];
  g /= GH;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) lum[y * GW + x] -= rowMean[y] + colMean[x] - g;

  const shearAt = (a: number, y: number, x: number): number => {
    let sx = x - a * y;
    sx = ((sx % GW) + GW) % GW;
    return lum[y * GW + (sx | 0)];
  };

  const lagMin = Math.max(3, Math.ceil((24 / w) * GW));
  const lagMax = Math.floor(GW / 3);
  const A_MIN = -2.5;
  const A_MAX = 2.5;
  const A_STEP = 0.02;
  let bestA = 0;
  let bestCoherence = 0;
  let bestAc: Float64Array | null = null;
  let bestDc = 0;
  for (let a = A_MIN; a <= A_MAX + 1e-9; a += A_STEP) {
    const meanRow = new Float64Array(GW);
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) meanRow[x] += shearAt(a, y, x);
    }
    for (let x = 0; x < GW; x++) meanRow[x] /= GH;
    const hp = highpass(meanRow, GW >> 3);
    const { ac, dc } = autocorr1d(hp);
    // 谐波相干度做判据：真实周期水印的基频处 1L/2L/3L/4L 自相关同时成峰 → 相干度高；
    // 纯噪声/内容无谐波结构 → 相干度≈随机波动（很小）。比单纯 dc 归一化稳健
    // （噪声下 dc≈0 会让比值虚高，相干度则不受此影响）。
    const f = fundamentalLag(ac, lagMin, lagMax, dc);
    if (f.coherence > bestCoherence) {
      bestCoherence = f.coherence;
      bestA = a;
      bestAc = ac;
      bestDc = dc;
    }
  }

  // 存在性门槛：谐波相干度须显著（>0.35）。噪声/内容下≈0.1~0.3（随机波动），被拒；
  // 真实周期水印下基频+谐波同时成峰，相干度 >0.4。留足 margin 避免噪声误报。
  if (bestCoherence < 0.35 || !bestAc) return null;
  const fund = fundamentalLag(bestAc, lagMin, lagMax, bestDc).lag;
  const tx = Math.round((fund / GW) * w);
  if (tx < 24 || tx > w / 2) return null;
  return { tx, shearK: bestA, score: bestCoherence };
}

/** 水平剪切重采样（双线性），输出到加宽画布（宽 sw）。越界源像素 clamp 到边缘。 */
function shearToWide(
  src: Uint8ClampedArray | Uint8Array | Float64Array,
  w: number,
  h: number,
  k: number,
  sw: number,
  out: Float64Array,
): void {
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const outRow = y * sw;
    const ku = k * y;
    for (let x2 = 0; x2 < sw; x2++) {
      const sx = x2 - ku; // 采样源 x = x'' − k·y
      const idx = (outRow + x2) * 4;
      const clampedSx = Math.max(0, Math.min(w - 1, sx));
      const x0 = Math.floor(clampedSx);
      const x1 = Math.min(w - 1, x0 + 1);
      const t = clampedSx - x0;
      for (let c = 0; c < 3; c++) {
        const v0 = src[(srcRow + x0) * 4 + c];
        const v1 = src[(srcRow + x1) * 4 + c];
        out[idx + c] = v0 + t * (v1 - v0);
      }
      out[idx + 3] = 255;
    }
  }
}

/** 宽画布 → 原画布 逆剪切（采样 out 在 x + k·y）。越界像素 clamp 到宽画布边缘。 */
function shearFromWide(
  wide: Float64Array,
  w: number,
  h: number,
  k: number,
  sw: number,
  out: Uint8ClampedArray,
): void {
  for (let y = 0; y < h; y++) {
    const wideRow = y * sw;
    const outRow = y * w;
    const ku = k * y;
    for (let x = 0; x < w; x++) {
      const sx = x + ku; // 对应宽画布 x''
      const idx = (outRow + x) * 4;
      const clampedSx = Math.max(0, Math.min(sw - 1, sx));
      const x0 = Math.floor(clampedSx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const t = clampedSx - x0;
      const wIdx0 = (wideRow + x0) * 4;
      const wIdx1 = (wideRow + x1) * 4;
      for (let c = 0; c < 3; c++) {
        out[idx + c] = Math.max(0, Math.min(255, wide[wIdx0 + c] + t * (wide[wIdx1 + c] - wide[wIdx0 + c])));
      }
    }
  }
}

/** 水平 box blur（O(N)，前缀和），半径 r，作用于宽 sw 画布。 */
function horizontalBoxBlurWide(src: Float64Array, sw: number, h: number, r: number): Float64Array {
  const out = new Float64Array(sw * h * 4);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      const rowBase = y * sw;
      const pref = new Float64Array(sw + 1);
      for (let x = 0; x < sw; x++) pref[x + 1] = pref[x] + src[(rowBase + x) * 4 + c];
      for (let x = 0; x < sw; x++) {
        const lo = Math.max(0, x - r);
        const hi = Math.min(sw - 1, x + r);
        out[(rowBase + x) * 4 + c] = (pref[hi + 1] - pref[lo]) / (hi - lo + 1);
      }
    }
  }
  return out;
}

/**
 * 斜向中值叠瓦去水印主入口。原地修改 rgba。
 *
 * @param tx      水平周期（原始像素），来自 estimateObliqueWatermark
 * @param shearK  剪切斜率 a（每向下一行水印水平平移 a 像素）
 * @returns true 表示执行；false 表示参数不可信。
 */
export function removeDiagonalWatermarkByTiling(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  tx: number,
  shearK: number,
): boolean {
  if (tx < 8 || tx > w / 2) return false;

  // 处理失败时用于回退的原始副本。
  const orig = rgba.slice();

  // 剪切需要加宽画布：总水平位移 = |a|·h，扩展后避免 clamp 把边缘内容复制成垃圾。
  const sw = w + Math.ceil(Math.abs(shearK) * h) + 2;
  const NW = sw * h;

  // ① 正向剪切到宽画布 sheared(x'',y) = in(x'' − a·y, y)。shearToWide 采样 (x2 − k·y)，
  //    故传入 k = +shearK (= a)。
  const sheared = new Float64Array(NW * 4);
  shearToWide(rgba, w, h, shearK, sw, sheared);

  // ② 水平相位中值（逐行）：对每行 y，把行内 x ≡ p (mod tx) 的同相位采样取中值写入
  //    M[row][p 相位点]。同相位采样点沿行相距 tx、内容稀疏 → 中值≈该行背景 + 水印 P(p)；
  //    随后的水平平滑再剔掉背景慢变项，相减即只剩纯水印调制（详见文件头推导）。
  const M = new Float64Array(NW * 4);
  const cap = Math.ceil(sw / tx);
  const vals = new Float64Array(tx * cap);
  const lens = new Uint32Array(tx);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      const rowBase = y * sw;
      lens.fill(0);
      for (let x = 0; x < sw; x++) {
        const p = ((x % tx) + tx) % tx;
        const slot = p * cap + lens[p]++;
        vals[slot] = sheared[(rowBase + x) * 4 + c];
      }
      for (let p = 0; p < tx; p++) {
        const len = lens[p];
        if (len === 0) continue;
        const arr = vals.subarray(p * cap, p * cap + len);
        arr.sort((a, b) => a - b);
        const med = arr[len >> 1];
        for (let x = p; x < sw; x += tx) M[(rowBase + x) * 4 + c] = med;
      }
    }
  }

  // ③ 水平平滑：窗口取 3·tx 整数倍，把周期水印抹成常数、保留缓慢背景
  const S = horizontalBoxBlurWide(M, sw, h, 3 * tx);

  // ④ 减回纯水印调制项（宽画布上）
  const processed = new Float64Array(NW * 4);
  for (let i = 0; i < NW; i++) {
    const ii = i * 4;
    for (let c = 0; c < 3; c++) {
      processed[ii + c] = sheared[ii + c] - (M[ii + c] - S[ii + c]);
    }
  }
  // ⑤ 逆剪切恢复回原画布（只写回 [0,w) 范围）
  shearFromWide(processed, w, h, shearK, sw, rgba);

  // ⑥ 质量门：若处理后大量像素被**新增** clamp 到 0/255，说明中值层误捕了内容结构
  // （稀疏文字/聊天行被当成周期水印），导致发花。此时回退到原图，让调用方
  // 走 FFT 兜底或提示用户切手动 / OCR 自动。
  // ❌ 只统计「原本在 (1,254) 开区间内、处理后却落到极值」的像素：白底截图（文档/
  //    聊天窗口）大面积像素本来就是 255，减回还偏向更亮——按绝对极值计数会让质量门
  //    在最常见的白底场景恒触发、斜向算法形同虚设。分母也只算内容像素。
  // 0.03 在稀疏文字水印上太严：实测真图 clip≈0.04 时只是边缘笔画正常压到极值，
  // 内容并未发花，回退反而让用户觉得「明明有水印却说没检出」。放宽到 0.12。
  const clipThresh = 0.12;
  let clip = 0;
  let denom = 0;
  for (let i = 0; i < w * h; i++) {
    const ii = i * 4;
    for (let c = 0; c < 3; c++) {
      const o = orig[ii + c];
      if (o > 1 && o < 254) {
        denom++;
        const v = rgba[ii + c];
        if (v <= 1 || v >= 254) clip++;
      }
    }
  }
  if (denom > 0 && clip / denom > clipThresh) {
    rgba.set(orig);
    return false;
  }
  return true;
}
