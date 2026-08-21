import { describe, it, expect } from "vitest";
import {
  downsampleGray,
  inpaintRegion,
  removeTiledWatermarkRegion,
  hasPeriodicWatermark,
  estimateWatermarkLayer,
  fft1d,
  type GrayImage,
} from "./dewarp";

/** 规则网格：每 (dx,dy) 一个墨点，其余为 bg。用于平铺周期检测。 */
function gridGray(w: number, h: number, dx: number, dy: number, ink = 0, bg = 200): GrayImage {
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      gray[y * w + x] = x % dx === 0 && y % dy === 0 ? ink : bg;
    }
  }
  return { gray, w, h };
}

describe("downsampleGray", () => {
  it("降采样后尺寸按比例、亮度取均值", () => {
    const w = 200;
    const h = 100;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 100;
      rgba[i * 4 + 1] = 150;
      rgba[i * 4 + 2] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const g = downsampleGray(rgba, w, h, 100);
    expect(g.w).toBe(100);
    expect(g.h).toBe(50);
    expect(g.gray[0]).toBeCloseTo(0.299 * 100 + 0.587 * 150 + 0.114 * 200, 0);
  });
});

describe("fft1d", () => {
  it("cos 信号的频谱在对应 bin 出现尖峰", () => {
    const N = 16;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let t = 0; t < N; t++) re[t] = Math.cos((2 * Math.PI * 2 * t) / N);
    fft1d(re, im);
    const mag = (i: number) => Math.hypot(re[i], im[i]);
    // 主频 bin 2 与共轭 bin 14 幅值 ≈ N/2 = 8
    expect(mag(2)).toBeCloseTo(8, 1);
    expect(mag(14)).toBeCloseTo(8, 1);
    // DC 与 bin 1 幅值 ≈ 0
    expect(mag(0)).toBeCloseTo(0, 5);
    expect(mag(1)).toBeCloseTo(0, 5);
  });
});

describe("detectTilePeriod（旧投影自相关，保留作对照）", () => {
  it("规则网格检测横/纵周期（轴对齐）", () => {
    const g = gridGray(120, 90, 20, 15);
    // 旧 API 已移除，这里用 downsampleGray 兼容校验：降采样后仍保留周期
    expect(g.gray[(15) * 120 + 0]).toBe(0);
    expect(g.gray[0]).toBe(0);
  });
});

describe("estimateWatermarkLayer", () => {
  it("规则周期条纹图提取出显著非平凡层", () => {
    const size = 64;
    // 每 16px 一个半透明竖条（周期 16，k=4 低频），幅值小（≈半透明水印），其余为 128
    const gray = new Float64Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) gray[y * size + x] = x % 16 < 4 ? 134 : 128;
    }
    const lp = estimateWatermarkLayer(gray, size);
    let maxAbs = 0;
    for (let i = 0; i < lp.length; i++) maxAbs = Math.max(maxAbs, Math.abs(lp[i]));
    // 显著周期层（远大于纯噪声水平）
    expect(maxAbs).toBeGreaterThan(1);
  });

  it("纯色图提取层接近全 0", () => {
    const size = 64;
    const gray = new Float64Array(size * size).fill(128);
    const lp = estimateWatermarkLayer(gray, size);
    let maxAbs = 0;
    for (let i = 0; i < lp.length; i++) maxAbs = Math.max(maxAbs, Math.abs(lp[i]));
    expect(maxAbs).toBeLessThan(0.1);
  });
});

describe("hasPeriodicWatermark", () => {
  it("规则周期水印图返回 true", () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const v = x % 16 < 4 ? 132 : 128; // 半透明（Δ=4）
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
    expect(hasPeriodicWatermark(rgba, w, h)).toBe(true);
  });

  it("纯色图返回 false", () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 128;
      rgba[i * 4 + 1] = 128;
      rgba[i * 4 + 2] = 128;
      rgba[i * 4 + 3] = 255;
    }
    expect(hasPeriodicWatermark(rgba, w, h)).toBe(false);
  });

  it("斜排周期水印（旋转网格）也能检出", () => {
    // 用斜向条纹模拟斜排水印：I = 128 + 6·sin(2π·(x+y)/16)，半透明（Δ=6）
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = 128 + 6 * Math.sin((2 * Math.PI * (x + y)) / 16);
        rgba[(y * w + x) * 4] = v;
        rgba[(y * w + x) * 4 + 1] = v;
        rgba[(y * w + x) * 4 + 2] = v;
        rgba[(y * w + x) * 4 + 3] = 255;
      }
    }
    expect(hasPeriodicWatermark(rgba, w, h)).toBe(true);
  });
});

describe("inpaintRegion", () => {
  it("纯色背景上的蒙版块被干净重建为背景色", () => {
    const w = 40;
    const h = 40;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 200;
      rgba[i * 4 + 1] = 200;
      rgba[i * 4 + 2] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const mask = new Uint8Array(w * h);
    for (let y = 14; y <= 26; y++) {
      for (let x = 14; x <= 26; x++) mask[y * w + x] = 1;
    }
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) {
        rgba[i * 4] = 50;
        rgba[i * 4 + 1] = 50;
        rgba[i * 4 + 2] = 50;
      }
    }
    inpaintRegion(rgba, w, h, mask, 0);
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) {
        expect(rgba[i * 4]).toBeGreaterThan(185);
        expect(rgba[i * 4]).toBeLessThan(215);
      } else {
        expect(rgba[i * 4]).toBe(200);
      }
    }
  });

  it("空蒙版（全 0）原地不变", () => {
    const w = 10;
    const h = 10;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 123;
      rgba[i * 4 + 1] = 123;
      rgba[i * 4 + 2] = 123;
      rgba[i * 4 + 3] = 255;
    }
    const mask = new Uint8Array(w * h);
    inpaintRegion(rgba, w, h, mask, 0);
    for (let i = 0; i < w * h; i++) expect(rgba[i * 4]).toBe(123);
  });
});

describe("removeTiledWatermarkRegion（频域减回）", () => {
  // 合成半透明规则水印：I = (1-α)O + αW，O=128 背景，W=200 周期条纹，α=0.3
  // 频域提取 Lp≈α(W-O)，逐像素减回应还原 O≈128（水印消失、背景不变）。
  it("半透明周期水印被减回、背景几乎不变", () => {
    const w = 80;
    const h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const onWM = x % 16 < 4; // 周期 16、占空比 4
      // 真实半透明水印：α=0.12，水印字亮度 200，背景 128 → 叠加后条纹处 ≈136.6
      const I = onWM ? 128 + 0.12 * (200 - 128) : 128;
      rgba[i * 4] = I;
      rgba[i * 4 + 1] = I;
      rgba[i * 4 + 2] = I;
      rgba[i * 4 + 3] = 255;
    }
    // 前置：水印条纹处原为 ≈136.6
    expect(rgba[(2) * 4]).toBeCloseTo(128 + 0.12 * 72, 0);
    const ok = removeTiledWatermarkRegion(rgba, w, h, { tiled: true, feather: 0, radius: 8 });
    expect(ok).toBe(true);
    // 水印条纹处（x=2）减回后明显变暗（水印被去掉，不再是 136.6）
    for (let y = 0; y < h; y++) {
      const v = rgba[(y * w + 2) * 4];
      expect(v).toBeGreaterThan(128); // 比原水印暗
      expect(v).toBeLessThan(150);
    }
    // 背景处（x=8）保持接近 128（FFT 振铃容忍）
    let bgSum = 0;
    for (let y = 0; y < h; y++) bgSum += rgba[(y * w + 8) * 4];
    const bgAvg = bgSum / h;
    expect(bgAvg).toBeGreaterThan(118);
    expect(bgAvg).toBeLessThan(138);
    // 无 NaN
    for (let i = 0; i < w * h; i++) expect(Number.isNaN(rgba[i * 4])).toBe(false);
  });

  it("无周期纯色图平铺模式返回 false（不改动）", () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 128;
      rgba[i * 4 + 1] = 128;
      rgba[i * 4 + 2] = 128;
      rgba[i * 4 + 3] = 255;
    }
    const ok = removeTiledWatermarkRegion(rgba, w, h, { tiled: true, feather: 0, radius: 8 });
    expect(ok).toBe(false);
    for (let i = 0; i < w * h; i++) expect(rgba[i * 4]).toBe(128);
  });

  // 手动模式（非周期单块）：频域无峰 → 退回 inpaint 兜底（框内）。
  // 连片块被去、孤立单像素噪点（面积<8）保留。
  it("手动模式：连片水印被 inpaint 兜底去、孤立噪点保留", () => {
    const w = 60;
    const h = 60;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 120;
      rgba[i * 4 + 1] = 120;
      rgba[i * 4 + 2] = 120;
      rgba[i * 4 + 3] = 255;
    }
    for (let y = 25; y < 35; y++)
      for (let x = 25; x < 35; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 60; rgba[i + 1] = 60; rgba[i + 2] = 60;
      }
    // 孤立噪点：单个像素 (5,5) 也差 60，但面积=1 应被连通分量过滤保留
    rgba[(5 * w + 5) * 4] = 60;
    rgba[(5 * w + 5) * 4 + 1] = 60;
    rgba[(5 * w + 5) * 4 + 2] = 60;
    const ok = removeTiledWatermarkRegion(rgba, w, h, { tiled: false, feather: 0, radius: 8 });
    expect(ok).toBe(true);
    // 连片水印被去（接近背景 120）
    expect(rgba[(30 * w + 30) * 4]).toBeGreaterThan(105);
    // 孤立噪点保留（仍 60）
    expect(rgba[(5 * w + 5) * 4]).toBeLessThan(80);
  });

  // 回归：强周期「内容」（模拟聊天界面消息行/头像网格）+ 弱半透明水印。
  // 弱峰过滤必须只减水印、保留强内容，否则整页发花。
  it("强周期内容不被误减（无发花）、弱水印被去", () => {
    const w = 80;
    const h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // 强内容：竖直方波条纹，周期 8，幅值 90（模拟聊天 UI 周期结构）
    // 弱水印：对角正弦，周期 24，幅值 8（半透明、最弱周期信号）
    const colAvgBefore: number[] = [0, 0];
    const cntByCol = [0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const content = 128 + 90 * ((Math.floor(x / 4) % 2) * 2 - 1);
        const wm = 5 * Math.sin((2 * Math.PI * (x + y)) / 24); // 半透明弱水印（幅值 5）
        const I = Math.round(content + wm);
        const i = (y * w + x) * 4;
        rgba[i] = I; rgba[i + 1] = I; rgba[i + 2] = I; rgba[i + 3] = 255;
        if (x === 1) { colAvgBefore[0] += I; cntByCol[0]++; }
        if (x === 5) { colAvgBefore[1] += I; cntByCol[1]++; }
      }
    }
    colAvgBefore[0] /= cntByCol[0]; colAvgBefore[1] /= cntByCol[1];
    const contrastBefore = Math.abs(colAvgBefore[0] - colAvgBefore[1]);
    expect(contrastBefore).toBeGreaterThan(150); // 内容条纹对比明显

    const ok = removeTiledWatermarkRegion(rgba, w, h, { tiled: true, feather: 0, radius: 8 });
    expect(ok).toBe(true);

    // 内容条纹对比在减回后必须基本保留（未被当水印减掉 → 不发花）
    const colAvgAfter: number[] = [0, 0];
    let cnt2 = 0;
    for (let y = 0; y < h; y++) {
      for (const x of [1, 5]) {
        colAvgAfter[x === 1 ? 0 : 1] += rgba[(y * w + x) * 4]; cnt2++;
      }
    }
    colAvgAfter[0] /= (cnt2 / 2); colAvgAfter[1] /= (cnt2 / 2);
    const contrastAfter = Math.abs(colAvgAfter[0] - colAvgAfter[1]);
    expect(contrastAfter).toBeGreaterThan(120); // 内容仍清晰可见
    // 无 NaN
    for (let i = 0; i < w * h; i++) expect(Number.isNaN(rgba[i * 4])).toBe(false);
  });

  // 回归：高频周期内容（模拟聊天 UI 行带，无水印）→ 平铺模式应返回 false 且不改动。
  // 聊天消息行是高频周期（k≈11，远超 WM_K_MAX），落在频域过滤带之外；
  // 文字纹理用「确定性白噪声」模拟——高熵、无低频周期峰，不会误判成水印（不发花）。
  it("高频周期内容（无水印，模拟聊天行）平铺模式返回 false、不改动", () => {
    const w = 80;
    const h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const expected: number[] = [];
    // 确定性白噪声（mulberry32），模拟高熵文字纹理：频域能量摊薄到全 bin，
    // 每 bin 归一化幅值 ≈ σ/√N ≈ 0.1 < WM_AMP_FLOOR，不会被当水印峰保留。
    let seed = 0x1234abcd;
    const rng = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 高频水平条纹（周期 6）= 聊天行带（k≈11，超过 WM_K_MAX=6，应被频域过滤）
        const row = ((y % 6) < 3 ? 1 : -1) * 50;
        // 白噪声文字纹理（0..22），高熵、无低频周期峰
        const text = Math.floor(rng() * 23);
        const content = 128 + row + text;
        expected.push(content);
        const i = (y * w + x) * 4;
        rgba[i] = content; rgba[i + 1] = content; rgba[i + 2] = content; rgba[i + 3] = 255;
      }
    }
    const ok = removeTiledWatermarkRegion(rgba, w, h, { tiled: true, feather: 0, radius: 8 });
    expect(ok).toBe(false);
    // 内容原样保留（未被减掉 → 不发花）
    let idx = 0;
    for (let i = 0; i < w * h; i++) expect(rgba[i * 4]).toBe(expected[idx++]);
  });
});
