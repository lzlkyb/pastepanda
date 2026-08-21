/**
 * 去水印频谱诊断工具。**已从主流程摘下，暂存备用**。
 *
 * 当时为什么需要它（已完成使命）：去水印对企业微信这类平铺水印不生效，而 dewarp.ts 里
 * 的三个门限（WM_K_MAX=6 / WM_AMP_FLOOR=0.5 / WM_AMP_CEIL=12）看着像是在某个特定
 * 样例上拍出来的。不拿真实截图的频谱数字就改门限，无非是再盲调一轮。
 *
 * 结论（2026-08-20）：判据已改成“轴外 + 格点整数倍”，WM_K_MAX 抬到 48。
 * 另外它自己也带出一个结论：抬 fftSize 没用 —— 256/512/1024 算出的峰位置与幅值
 * 几乎一样（实测 (2,2) 0.989 / 0.964 / 0.965），因为 fx/fy 的单位是“每选区周期数”。
 * 详见 dewarp.ts 文件头「已知天花板二（分辨率）」。
 *
 * 它**不改 dewarp.ts 一行**，只复用它导出的 fft1d，自己搭 2D FFT 与降采样，
 * 顺便把“换成区域均值降采样 / 抬高 fftSize 后数字会变成什么”一起扫出来，
 * 这样只跑一次就能一次定完 fftSize + 三个门限。
 */

import { fft1d } from "./dewarp";

/** ⚠ 这三个是 **2026-08-20 重做判据之前的旧值**，只当历史对照用，**不是**
 *  dewarp.ts 的当前值（现在 WM_K_MAX=48，且主判据已换成“轴外 + 格点整数倍”，
 *  不再是单纯的径向频率 + 幅值门）。所以报告里那个“通过数”**不能**用来判断
 *  现行检测会不会命中。要跟现行阈值对齐，得把 dewarp.ts 里的常量导出再引过来。 */
const CUR_K_MAX = 6;
const CUR_AMP_FLOOR = 0.5;
const CUR_AMP_CEIL = 12;

type Mode = "nearest" | "mean";

/** RGBA → 灰度降采样到 size×size。nearest = 当前实现；mean = 区域均值。 */
function downsample(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  size: number,
  mode: Mode,
): Float64Array {
  const out = new Float64Array(size * size);
  if (mode === "nearest") {
    for (let y = 0; y < size; y++) {
      const sy = Math.min(h - 1, Math.floor(((y + 0.5) / size) * h));
      for (let x = 0; x < size; x++) {
        const sx = Math.min(w - 1, Math.floor(((x + 0.5) / size) * w));
        const i = (sy * w + sx) * 4;
        out[y * size + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      }
    }
    return out;
  }
  // 区域均值（box filter）：10:1 降采样下，水印的 1~2px 细笔画才不会被整个跳过
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y / size) * h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) / size) * h));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x / size) * w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) / size) * w));
      let sum = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < h; sy++) {
        for (let sx = x0; sx < x1 && sx < w; sx++) {
          const i = (sy * w + sx) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      out[y * size + x] = n ? sum / n : 0;
    }
  }
  return out;
}

/** 2D FFT（行先后列），复用 dewarp.ts 导出的 1D fft1d。原地修改。 */
function fft2d(re: Float64Array, im: Float64Array, size: number): void {
  const rr = new Float64Array(size);
  const ri = new Float64Array(size);
  for (let y = 0; y < size; y++) {
    const off = y * size;
    for (let x = 0; x < size; x++) {
      rr[x] = re[off + x];
      ri[x] = im[off + x];
    }
    fft1d(rr, ri);
    for (let x = 0; x < size; x++) {
      re[off + x] = rr[x];
      im[off + x] = ri[x];
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      rr[y] = re[y * size + x];
      ri[y] = im[y * size + x];
    }
    fft1d(rr, ri);
    for (let y = 0; y < size; y++) {
      re[y * size + x] = rr[y];
      im[y * size + x] = ri[y];
    }
  }
}

interface Peak {
  fx: number;
  fy: number;
  k: number;
  amp: number;
}

/**
 * 输出幅值最大的前 n 个非 DC 频分量。
 *
 * ❗ 必须按 (fx,fy) 去重：(x,y) 与 (size-x,size-y) 是共轭对，折回同一个 (fx,fy)，
 * 不去重的话每个峰都打两遍，“前 8”实际只有 4 个不同的峰——水印峰根本露不出来。
 *
 * @param min2d >0 时只要 fx≥min2d 且 fy≥min2d 的峰。平铺水印是**二维格点**，两个
 *               分量都非零；而内容行/分割线这类水平条纹则趋于落在 fx=0 轴上。
 *               用它把两者分开看，否则水印会被内容的低频能量淹没。
 */
function topPeaks(
  re: Float64Array,
  im: Float64Array,
  size: number,
  n: number,
  min2d = 0,
): Peak[] {
  const norm = size * size;
  const best = new Map<string, Peak>();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (i === 0) continue; // DC
      const fx = x <= size / 2 ? x : size - x;
      const fy = y <= size / 2 ? y : size - y;
      if (fx <= 1 && fy <= 1) continue; // 最低频中心十字
      if (min2d > 0 && (fx < min2d || fy < min2d)) continue;
      const key = `${fx},${fy}`;
      const amp = Math.round((Math.hypot(re[i], im[i]) / norm) * 1000) / 1000;
      const prev = best.get(key);
      if (!prev || amp > prev.amp) {
        best.set(key, { fx, fy, k: Math.round(Math.hypot(fx, fy) * 10) / 10, amp });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.amp - a.amp).slice(0, n);
}

/**
 * 格点径向包络：对每个整数半径 k，取该半径上（fx≥2 且 fy≥2）的最大幅值。
 *
 * 为什么比 top-N 有用：top-N 永远被最强的低频占满，看不到远处有没有小山包。
 * 而平铺水印的指纹恰恰是“在某个 k 上凸起”：
 *   · 单调衰减 → 没有格点，频域路线在这张图上无信号可用；
 *   · 某个 k 凸起 → 那就是水印基频，直接拿它定门限。
 */
function radialEnvelope(
  re: Float64Array,
  im: Float64Array,
  size: number,
  kMax: number,
): number[] {
  const norm = size * size;
  const env = new Array<number>(kMax + 1).fill(0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (i === 0) continue;
      const fx = x <= size / 2 ? x : size - x;
      const fy = y <= size / 2 ? y : size - y;
      if (fx < 2 || fy < 2) continue;
      const k = Math.round(Math.hypot(fx, fy));
      if (k < 2 || k > kMax) continue;
      const amp = Math.hypot(re[i], im[i]) / norm;
      if (amp > env[k]) env[k] = amp;
    }
  }
  return env;
}

/** 旧门限（CUR_* 三个常量）下还剩几个候选峰，只看频率/幅值两道门、不做连通簇过滤。
 *  ⚠ 与 dewarp.ts 现行判据无关（那边现在是“轴外 + 格点整数倍 + 成员数”）。 */
function countPassingLegacyGate(re: Float64Array, im: Float64Array, size: number): number {
  const norm = size * size;
  let cnt = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (i === 0) continue;
      const fx = x <= size / 2 ? x : size - x;
      const fy = y <= size / 2 ? y : size - y;
      if (fx <= 1 && fy <= 1) continue;
      if (Math.hypot(fx, fy) > CUR_K_MAX) continue;
      const amp = Math.hypot(re[i], im[i]) / norm;
      if (amp < CUR_AMP_FLOOR || amp > CUR_AMP_CEIL) continue;
      cnt++;
    }
  }
  return cnt;
}

function pow2Floor(v: number): number {
  let p = 1;
  while (p * 2 <= v) p <<= 1;
  return Math.max(2, p);
}

/**
 * 扫一组 (fftSize, 降采样方式) 组合，返回人读报告。
 * 结果直接进剪贴板（调用方负责），用户贴回对话就能定门限。
 */
export function probeSpectrum(rgba: Uint8ClampedArray, w: number, h: number): string {
  const lines: string[] = [];
  lines.push(`[dewarp probe] 选区 ${w}x${h}`);
  // ⚠ 这行报的是**旧门限**，不是当前判据。标题必须写死“旧”：报告是要贴回对话的，
  // 写成“现行门限”会让人（包括我自己）拿这个通过数当成现行检测的命中情况。
  lines.push(
    `旧门限(仅历史对照，非当前判据): K_MAX=${CUR_K_MAX} AMP=[${CUR_AMP_FLOOR},${CUR_AMP_CEIL}]`,
  );
  const cap = pow2Floor(Math.min(w, h));
  const configs: { size: number; mode: Mode }[] = [
    { size: Math.min(256, cap), mode: "nearest" },
    { size: Math.min(256, cap), mode: "mean" },
    { size: Math.min(512, cap), mode: "mean" },
    { size: Math.min(1024, cap), mode: "mean" },
  ];
  const seen = new Set<string>();
  for (const cfg of configs) {
    const tag = `${cfg.size}/${cfg.mode}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    const t0 = performance.now();
    const gray = downsample(rgba, w, h, cfg.size, cfg.mode);
    const re = Float64Array.from(gray);
    const im = new Float64Array(cfg.size * cfg.size);
    fft2d(re, im, cfg.size);
    const pass = countPassingLegacyGate(re, im, cfg.size);
    const all = topPeaks(re, im, cfg.size, 12);
    // 二维格点候选：水印就该在这份里（两个分量都非零）
    const grid = topPeaks(re, im, cfg.size, 12, 2);
    const ms = Math.round(performance.now() - t0);
    const fmt = (ps: Peak[]) =>
      ps.map((p) => `(${p.fx},${p.fy})a=${p.amp}`).join(" ");
    lines.push(`--- size=${cfg.size} ${cfg.mode} (${ms}ms) 旧门限通过数=${pass}`);
    lines.push(`  全部: ${fmt(all)}`);
    lines.push(`  格点(fx,fy≥2): ${fmt(grid)}`);
    const kMax = Math.min(40, Math.floor(cfg.size / 2));
    const env = radialEnvelope(re, im, cfg.size, kMax);
    lines.push(
      "  径向包络: " +
        env
          .map((v, k) => (k < 2 ? "" : `${k}:${Math.round(v * 100) / 100}`))
          .filter(Boolean)
          .join(" "),
    );
  }
  return lines.join("\n");
}
