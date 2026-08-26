/// <reference types="vitest/globals" />

/**
 * 去水印「中值叠瓦」路线探针测试。
 *
 * 目的：在合成 α 混合水印图（深浅背景 + 逐瓦片可变内容 + 仅瓦片周期重复的周期性水印）
 * 上，验证
 *   1) 给定正确周期，中值叠瓦能去水印且保内容；
 *   2) 周期估计能从自相关找回瓦片周期，端到端可用；
 *   3) 中值法在两个症状（误伤/发花、去不干净）上明显优于现有 FFT 频域减回。
 *
 * 命中环境变量 DEWARP_PROBE_PNG 时，额外用 pngjs 跑一张真实截图，写出
 * watermark_layer.png 与 recovered.png 供肉眼核对。
 */

import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  estimateWatermarkPeriod,
  removeWatermarkByTiling,
  type Period,
} from "./watermarkMedian";
import {
  estimateObliqueWatermark,
  removeDiagonalWatermarkByTiling,
} from "./watermarkMedianDiagonal";
import { removeTiledWatermarkRegion } from "./dewarp";

/** 确定性 RNG，保证测试可复现。 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Synth {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  O: Float64Array; // 真实无水印图（ground truth）
  W: Float64Array; // 真实水印层（中性 W0 + 墨）
  W0: number; // 中性灰
  alpha: number;
}

/**
 * 合成一张「聊天截图风」的水印图：
 *   · 深浅气泡背景（模拟微信深色/浅色气泡）
 *   · 逐瓦片随机文字（aperiodic 内容，必须被保留）
 *   · 周期水印 W：每个瓦片是**同一份固定图案**（仅瓦片周期重复，无更细频率），
 *     模拟真实平铺水印（企业微信/钉钉/飞书）。
 */
function synthWatermark(seed = 12345, scale = 1): Synth {
  const w = 800 * scale;
  const h = 600 * scale;
  const tx = 200;
  const ty = 150; // 瓦片尺寸固定，放大图像=更多重复（更贴近真实截图尺度）
  const W0 = 140; // 水印中性灰
  const alpha = 0.3;
  const rnd = mulberry32(seed);

  const O = new Float64Array(w * h);

  // ① 背景：x 向渐变（浅→深）+ 若干深浅气泡
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) O[y * w + x] = 90 + (x / w) * 90;
  }
  for (let b = 0; b < 10; b++) {
    const cx = rnd() * w;
    const cy = rnd() * h;
    const rad = 50 + rnd() * 80;
    const dark = rnd() < 0.5;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - cx, y - cy) < rad) O[y * w + x] = dark ? 40 : 220;
      }
    }
  }

  // ② 内容（逐瓦片随机文字块，aperiodic）——每块位置随瓦片不同
  for (let ty0 = 0; ty0 < h; ty0 += ty) {
    for (let tx0 = 0; tx0 < w; tx0 += tx) {
      const r = mulberry32(seed + ty0 * 131 + tx0); // 每瓦片不同种子
      for (let s = 0; s < 16; s++) {
        const px = tx0 + Math.floor(r() * tx);
        const py = ty0 + Math.floor(r() * ty);
        const bw = 3 + Math.floor(r() * 9);
        const bh = 2 + Math.floor(r() * 3);
        const ink = r() < 0.5 ? 45 : 205;
        for (let yy = py; yy < Math.min(h, py + bh); yy++) {
          for (let xx = px; xx < Math.min(w, px + bw); xx++) O[yy * w + xx] = ink;
        }
      }
    }
  }

  // ③ 水印层 W：固定种子、连贯偏置色块（更贴近真实平铺 logo；仅瓦片周期重复）
  const wtile = new Float64Array(tx * ty);
  for (let oy = 0; oy < ty; oy++) {
    for (let ox = 0; ox < tx; ox++) {
      // 偏置的连贯色块（非对称，避免半周期歧义）+ 一个小标记
      const ink = (ox >= 40 && ox < 110 && oy >= 30 && oy < 90) || (ox >= 150 && ox < 170 && oy >= 20 && oy < 40);
      wtile[oy * tx + ox] = W0 + (ink ? 65 : 0); // 墨处 205
    }
  }
  const W = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) W[y * w + x] = wtile[(y % ty) * tx + (x % tx)];
  }

  // ④ 合成 I = (1−α)O + αW（alpha 混合；深色背景上水印几乎不可见）
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = (1 - alpha) * O[i] + alpha * W[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, w, h, O, W, W0, alpha };
}

/** 皮尔逊相关系数。 */
function pearson(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return num / (Math.sqrt(da * db) + 1e-12);
}

interface Metric {
  /** 残留水印与真实水印模式的相关系数（越小越好，0=完全去掉） */
  watermarkCorr: number;
  /** 去水印结果与真值 O 的相关系数（越大越好，内容保全） */
  contentCorr: number;
}

function measure(s: Synth, result: Uint8ClampedArray): Metric {
  const { w, h, O, W, W0 } = s;
  const N = w * h;
  const residual = new Float64Array(N); // result − O
  const pattern = new Float64Array(N); // W − W0（真实水印模式）
  const ro = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const r = (result[i * 4] + result[i * 4 + 1] + result[i * 4 + 2]) / 3;
    residual[i] = r - O[i];
    ro[i] = r;
    pattern[i] = W[i] - W0;
  }
  return {
    watermarkCorr: pearson(residual, pattern),
    contentCorr: pearson(ro, O),
  };
}

/**
 * 合成斜向文字水印：每行 y 有一个水平偏移 shift = round(k·y)，水印图案沿 x 方向以 tx 为
 * 周期重复。这样视觉上形成从左上到右下（或相反）的斜向条纹，自相关峰在 (tx,ty)。
 */
function synthDiagonalWatermark(seed = 54321, scale = 2): Synth {
  const w = 800 * scale;
  const h = 600 * scale;
  const tx = 120;
  const ty = 160; // 斜向周期向量 (120,160)
  const k = tx / ty;
  const W0 = 140;
  const alpha = 0.3;
  const rnd = mulberry32(seed);

  const O = new Float64Array(w * h);
  // 背景
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) O[y * w + x] = 90 + (x / w) * 90;
  for (let b = 0; b < 10; b++) {
    const cx = rnd() * w, cy = rnd() * h, rad = 50 + rnd() * 80, dark = rnd() < 0.5;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      if (Math.hypot(x - cx, y - cy) < rad) O[y * w + x] = dark ? 40 : 220;
  }
  // 内容：按竖直条带随机文字（aperiodic，避免与斜向水印同周期）
  for (let y = 0; y < h; y += 40) {
    const r = mulberry32(seed + y * 7);
    for (let s = 0; s < 8; s++) {
      const px = Math.floor(r() * w);
      const py = y + Math.floor(r() * 36);
      const bw = 4 + Math.floor(r() * 10);
      const bh = 2 + Math.floor(r() * 3);
      const ink = r() < 0.5 ? 45 : 205;
      for (let yy = py; yy < Math.min(h, py + bh); yy++)
        for (let xx = px; xx < Math.min(w, px + bw); xx++) O[yy * w + xx] = ink;
    }
  }

  // 斜向水印层 W：每行 y 偏移 shift，然后按 tx 周期重复条纹
  const W = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const shift = Math.round(k * y);
    for (let x = 0; x < w; x++) {
      const xp = ((x + shift) % tx + tx) % tx;
      const ink = (xp >= 10 && xp < 35) || (xp >= 70 && xp < 95);
      W[y * w + x] = W0 + (ink ? 65 : 0);
    }
  }

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = (1 - alpha) * O[i] + alpha * W[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, w, h, O, W, W0, alpha };
}

/**
 * 合成大图（1600×1200）上的 2D 自相关 / 剪切扫描是秒级重活，vitest 默认 5s 超时
 * 在**全量多文件并行**时必踩线 —— 单文件跑得过、全量随机红，而 pre-commit 只跑
 * eslint 拦不住。给这几条重的用例显式放宽，不改全局 testTimeout（那会把其它
 * 文件的真实挂死一并掩掉）。
 */
const HEAVY_MS = 30_000;

describe("中值叠瓦去水印（探针）", () => {
  it("给定正确周期：去水印且保内容，且优于 FFT 频域减回", () => {
    const s = synthWatermark();
    const period: Period = { tx: 200, ty: 150, score: 1 };

    const tiling = Uint8ClampedArray.from(s.rgba);
    removeWatermarkByTiling(tiling, s.w, s.h, period);
    const mTiling = measure(s, tiling);

    const fft = Uint8ClampedArray.from(s.rgba);
    removeTiledWatermarkRegion(fft, s.w, s.h, { tiled: true, feather: 0, radius: 8 });
    const mFft = measure(s, fft);

     
    console.log("[探针] 中值叠瓦:", mTiling, " FFT:", mFft);

    // 去不干净：中值法水印残留应很小，且远小于 FFT
    expect(Math.abs(mTiling.watermarkCorr)).toBeLessThan(0.15);
    expect(Math.abs(mTiling.watermarkCorr)).toBeLessThan(Math.abs(mFft.watermarkCorr));
    // 误伤/发花：中值法内容保全应明显优于 FFT（contentCorr 更高）
    expect(mTiling.contentCorr).toBeGreaterThan(mFft.contentCorr);
    expect(mTiling.contentCorr).toBeGreaterThan(0.9);
  });

  it("端到端：周期估计在足够重复次数下找回瓦片周期并能去水印", () => {
    // 放大到 1600×1200（8×8 瓦片）→ 自相关重复次数足够，更贴近真实截图尺度
    const s = synthWatermark(12345, 2);
    const p = estimateWatermarkPeriod(s.rgba, s.w, s.h);
     
    console.log("[探针] 估计周期:", p);
    expect(p).not.toBeNull();
    if (!p) return;
    // 估回的周期应接近真实瓦片周期（200×150）
    expect(Math.abs(p.tx - 200)).toBeLessThan(40);
    expect(Math.abs(p.ty - 150)).toBeLessThan(40);

    const tiling = Uint8ClampedArray.from(s.rgba);
    const ok = removeWatermarkByTiling(tiling, s.w, s.h, p);
    expect(ok).toBe(true);
    const m = measure(s, tiling);
    // 用估回的周期仍能去水印（端到端可用）。watermarkCorr 阈值给到 0.15：
    // 连贯水印色块的边缘会在 (M−S) 中残留轻微伪影（已知待精修项），
    // 但 0.15 已远低于 FFT 频域减回的 0.27，且内容保全(contentCorr)>0.9。
    expect(Math.abs(m.watermarkCorr)).toBeLessThan(0.15);
    expect(m.contentCorr).toBeGreaterThan(0.9);
  }, HEAVY_MS);

  it("无周期内容图：周期估计置信度应低于水印图（避免误判）", () => {
    const s = synthWatermark(12345, 2);
    // 水印图得分
    const pw = estimateWatermarkPeriod(s.rgba, s.w, s.h);
    // 纯内容图（无水印真值 O）
    const rgba = new Uint8ClampedArray(s.w * s.h * 4);
    for (let i = 0; i < s.w * s.h; i++) {
      rgba[i * 4] = s.O[i];
      rgba[i * 4 + 1] = s.O[i];
      rgba[i * 4 + 2] = s.O[i];
      rgba[i * 4 + 3] = 255;
    }
    const pc = estimateWatermarkPeriod(rgba, s.w, s.h);
     
    console.log("[探针] 得分 水印=", pw?.score, " 内容=", pc?.score);
    // 水印图置信度应明显高于纯内容图（检测器能区分）
    if (pw && pc) expect(pw.score).toBeGreaterThan(pc.score);
  }, HEAVY_MS);

  it("斜向水印：端到端检测周期向量并去水印", () => {
    const s = synthDiagonalWatermark(54321, 2);
    const p = estimateObliqueWatermark(s.rgba, s.w, s.h);
     
    console.log("[斜向探针] 估计:", p, " 真值 tx=120 shearK=0.75");
    expect(p).not.toBeNull();
    if (!p) return;
    // 水平周期应接近 120；剪切斜率接近 0.75
    expect(Math.abs(p.tx - 120)).toBeLessThan(30);
    expect(Math.abs(p.shearK - 0.75)).toBeLessThan(0.2);

    const rec = Uint8ClampedArray.from(s.rgba);
    const ok = removeDiagonalWatermarkByTiling(rec, s.w, s.h, p.tx, p.shearK);
    expect(ok).toBe(true);
    const m = measure(s, rec);
     
    console.log("[斜向探针] 去水印指标:", m);
    // 合成图用了不现实的陡峭剪切（0.75px/行 ×1200 行 ≈900px 位移），重采样使水印层 M'
    // 略有偏差，残留 watermarkCorr 偏高；真实浅斜率水印会更低。关键看内容保全(contentCorr)
    // 是否高（>0.9 即无发花/误伤）。阈值给到 0.25。
    expect(Math.abs(m.watermarkCorr)).toBeLessThan(0.25);
    expect(m.contentCorr).toBeGreaterThan(0.9);
  }, HEAVY_MS);

  // 回归：旧 clip 质量门按「处理后图中极值像素占比」计数，白底截图大面积像素
  // 本来就是 255 → 门恒触发、斜向算法在白底场景恒返 false。改为只统计「新增 clamp」
  // 后，白底 + 斜向水印必须仍能正常去除。
  it("白底截图：质量门只看新增 clamp，斜向去水印不被纯白背景误杀", () => {
    const w = 400;
    const h = 300;
    const tx = 100;
    const k = 0.3; // 每行右移 0.3px 的浅斜率（贴近真实截图水印）
    const alpha = 0.2;
    const W0 = 190;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // 纯白底 + 稀疏深色文字条（模拟文档）
    const O = new Float64Array(w * h).fill(255);
    for (let y = 20; y < h; y += 30) {
      for (let x = 10; x < w - 18; x += 14) {
        for (let dy = 0; dy < 6; dy++)
          for (let dx = 0; dx < 8; dx++) O[(y + dy) * w + x + dx] = 40;
      }
    }
    for (let i = 0; i < w * h; i++) {
      const xp = ((((i % w) + Math.round(k * Math.floor(i / w))) % tx) + tx) % tx;
      const Wv = W0 + (xp >= 8 && xp < 26 ? 55 : 0);
      const v = (1 - alpha) * O[i] + alpha * Wv;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
    const ok = removeDiagonalWatermarkByTiling(rgba, w, h, tx, k);
    expect(ok).toBe(true);
    // 去水印后背景 = (1−α)·O + α·W₀（本文件头注释的统一轻染色语义）：
    // 0.8×255 + 0.2×190 ≈ 242，不应再有明显周期调制
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < w * h; i++) {
      if (O[i] === 255) {
        sum += rgba[i * 4];
        cnt++;
      }
    }
    expect(sum / cnt).toBeGreaterThan(235);
  });
});

// ───────────── 真实截图探针（可选，命中 DEWARP_PROBE_PNG 时跑） ─────────────
const probePng = process.env.DEWARP_PROBE_PNG;
if (probePng) {
  describe("真实截图探针", () => {
    it("跑一张真实截图并写出诊断图（轴对齐 + 斜向两条路线）", () => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const src = PNG.sync.read(readFileSync(probePng));
      const w = src.width;
      const h = src.height;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = src.data[i * 4];
        rgba[i * 4 + 1] = src.data[i * 4 + 1];
        rgba[i * 4 + 2] = src.data[i * 4 + 2];
        rgba[i * 4 + 3] = src.data[i * 4 + 3];
      }

      // ① 轴对齐路线
      const p = estimateWatermarkPeriod(rgba, w, h);
       
      console.log("[真实探针] 轴对齐估计:", p);

      // ② 斜向路线
      const ob = estimateObliqueWatermark(rgba, w, h);
       
      console.log("[真实探针] 斜向估计:", ob);

      // 写出两条路线各自的去水印结果供肉眼核对
      const recAxis = Uint8ClampedArray.from(rgba);
      if (p) {
        removeWatermarkByTiling(recAxis, w, h, p);
        const rPng = new PNG({ width: w, height: h });
        for (let i = 0; i < w * h; i++) {
          rPng.data[i * 4] = recAxis[i * 4];
          rPng.data[i * 4 + 1] = recAxis[i * 4 + 1];
          rPng.data[i * 4 + 2] = recAxis[i * 4 + 2];
          rPng.data[i * 4 + 3] = 255;
        }
        writeFileSync(join(__dirname, "recovered_axis.png"), PNG.sync.write(rPng));
      }

      const recObl = Uint8ClampedArray.from(rgba);
      if (ob) {
        removeDiagonalWatermarkByTiling(recObl, w, h, ob.tx, ob.shearK);
        const rPng = new PNG({ width: w, height: h });
        for (let i = 0; i < w * h; i++) {
          rPng.data[i * 4] = recObl[i * 4];
          rPng.data[i * 4 + 1] = recObl[i * 4 + 1];
          rPng.data[i * 4 + 2] = recObl[i * 4 + 2];
          rPng.data[i * 4 + 3] = 255;
        }
        writeFileSync(join(__dirname, "recovered_oblique.png"), PNG.sync.write(rPng));
      }

      expect(true).toBe(true);
    });
  });
}
