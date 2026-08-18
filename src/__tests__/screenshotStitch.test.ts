/**
 * 长截图拼接：重叠行匹配与帧稳定性判断。
 *
 * 本文件存在的理由：`overlapRowsFromData` 里曾有一个静默的真 bug——
 * G/B 两个通道写成了 `d2[i1+1] / d2[i1+2]`，拿 prev 的行偏移去索引 next，
 * 于是三个通道里只有 R 在做「错位 k 行的匹配」，G/B 变成了「同位置两帧之差」。
 * tsc / eslint 都抓不到（索引合法、类型都对），只有造数据断言能钉住它。
 *
 * 所以下面的造图刻意让 **R/G/B 三个通道取不同值**；
 * 若只用灰度图（R=G=B），拿错通道也看不出来，测试就失去意义。
 */

import { describe, it, expect } from "vitest";
import {
  framesAlike,
  globalDiff,
  overlapRowsFromData,
  stickyTopFromData,
  GLOBAL_DIFF_T,
} from "@/lib/screenshot/stitch";

const W = 8;
const SH = 30;

/** 第 row 行的颜色——三通道各不相同，专门用来暴露「拿错通道」 */
function rowColor(row: number): [number, number, number] {
  return [row * 8, row * 8 + 3, row * 8 + 7];
}

/**
 * 造一张**带横向纹理**的图（同一行内颜色随列变化）。
 *
 * 为什么吸顶带的用例必须用它：`stickyTopFromData` 要求带内有结构——
 * 纯色带（空白 / 纯背景）在两帧里当然逐行一致，把它当吸顶带剔掉会让长图
 * **静默丢内容**，所以判定会（正确地）拒绝横向纯色的带。
 * 真实的吸顶导航栏里是有内容的，这里的条纹就是在模拟那个。
 *
 * ⚠️ 条纹周期取 4 而不是 2：判定按 `col += 2` 采样，周期 2 的条纹在偶数列上
 * 取值恒定，varSum 会是 0 —— 等于又造了一条“纯色带”。
 */
function makeTextured(colorOf: (row: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * SH * 4);
  for (let row = 0; row < SH; row++) {
    const [r, g, b] = colorOf(row);
    for (let col = 0; col < W; col++) {
      const i = (row * W + col) * 4;
      const t = col % 4 < 2 ? 0 : 120;
      d[i] = Math.min(255, r + t);
      d[i + 1] = Math.min(255, g + t);
      d[i + 2] = Math.min(255, b + t);
      d[i + 3] = 255;
    }
  }
  return d;
}

/** 按「行 → 颜色」函数造一张 W×SH 的 RGBA 图 */
function makeFrame(colorOf: (row: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * SH * 4);
  for (let row = 0; row < SH; row++) {
    const [r, g, b] = colorOf(row);
    for (let col = 0; col < W; col++) {
      const i = (row * W + col) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  return d;
}

/** 向上滚动 scroll 行：next 第 i 行 = prev 第 (i+scroll) 行；超出部分是全新内容 */
function scrolled(scroll: number): Uint8ClampedArray {
  return makeFrame((row) => {
    const src = row + scroll;
    return src < SH ? rowColor(src) : [200 + row, 130 + row, 60 + row];
  });
}

describe("overlapRowsFromData", () => {
  it("滚动 15 行后，能算出 15 行重叠（三通道均不同值，拿错通道会失败）", () => {
    const prev = makeFrame(rowColor);
    const next = scrolled(15);
    // scale = 1（直接按小图尺寸算），maxK = floor(30*0.6) = 18 > 15，能找到
    expect(overlapRowsFromData(prev, next, W, SH, 1)).toBe(15);
  });

  it("重叠行数会按 scale 换算回原图尺度", () => {
    const prev = makeFrame(rowColor);
    const next = scrolled(15);
    // 小图是原图的 1/2 → 15 行小图 = 30 行原图
    expect(overlapRowsFromData(prev, next, W, SH, 0.5)).toBe(30);
  });

  it("画面完全未变化时返回 0（视为已滚到底）", () => {
    const same = makeFrame(rowColor);
    expect(overlapRowsFromData(same, makeFrame(rowColor), W, SH, 1)).toBe(0);
    expect(overlapRowsFromData(same, same, W, SH, 1)).toBe(0);
  });

  it("内容全换（无重叠）时返回 0", () => {
    const prev = makeFrame(rowColor);
    const next = makeFrame((row) => [255 - row * 3, 100 + row * 2, 30 + row]);
    expect(overlapRowsFromData(prev, next, W, SH, 1)).toBe(0);
  });

  it("滚动幅度过小导致重叠超过 maxK 时，不会返回错误的小重叠值", () => {
    // 只滚 2 行 → 真实重叠 28 行，超过 maxK(18)，找不到完整匹配
    const prev = makeFrame(rowColor);
    const next = scrolled(2);
    const got = overlapRowsFromData(prev, next, W, SH, 1);
    // 允许返回 0（未找到），但绝不能返回一个“看上去像对”的小值造成错位拼接
    expect(got === 0 || got >= 18).toBe(true);
  });

  it("topSkip=0 时吸顶无关，重叠计算不受参数影响（回归）", () => {
    const prev = makeFrame(rowColor);
    const next = scrolled(15);
    expect(overlapRowsFromData(prev, next, W, SH, 1, 0)).toBe(15);
  });

  it("带吸顶带时：stickyTopFromData 识别带高，topSkip=带高 后重叠从带下算", () => {
    const STICKY = 5;
    const SCROLL = 15;
    // 用带纹理的图：吸顶栏必须“有内容”才算吸顶（见 makeTextured 的注释）
    const prev = makeTextured(rowColor);
    // next：顶部 STICKY 行与 prev 相同（吸顶），其下内容相对 prev 偏移 SCROLL
    const next = makeTextured((row) => {
      if (row < STICKY) return rowColor(row);
      const src = row - STICKY + SCROLL;
      return src < SH ? rowColor(src) : [200 + row, 130 + row, 60 + row];
    });
    const sticky = stickyTopFromData(prev, next, W, SH, 1);
    expect(sticky).toBe(STICKY);
    // 吸顶带下内容相对 prev 偏移 SCROLL，topSkip=STICKY 后应得到 SCROLL（而非把吸顶带当重叠）
    expect(overlapRowsFromData(prev, next, W, SH, 1, sticky)).toBe(SCROLL);
  });

  /**
   * 回归：吸顶带判定必须逐行连续、且带内要有结构。
   *
   * 旧实现取「整带均值」并从最大 k 往下找首个命中，两点都偏向报大：
   * 均值会让一两行差得很远的行被其余几十行摊薄，而纯色带（空白/纯背景）在两帧里
   * 天然逐行一致。sticky 报大多少，长图就静默少拼多少内容（seam = sticky + overlap），
   * 对拼接工具来说这是最糟的失败模式。
   */
  it("回归：横向纯色的顶部带不算吸顶（否则会静默丢内容）", () => {
    const STICKY = 5;
    const SCROLL = 15;
    // makeFrame 每行横向纯色 —— 顶部 5 行两帧一致，但那是“空白”，不是吸顶导航
    const prev = makeFrame(rowColor);
    const next = makeFrame((row) => {
      if (row < STICKY) return rowColor(row);
      const src = row - STICKY + SCROLL;
      return src < SH ? rowColor(src) : [200 + row, 130 + row, 60 + row];
    });
    expect(stickyTopFromData(prev, next, W, SH, 1)).toBe(0);
  });

  it("回归：第一行就对不上时吸顶带为 0（逐行连续，不靠整带均值）", () => {
    const prev = makeTextured(rowColor);
    // 顶部第 0 行就完全不同，后面若干行相同 —— 均值判定可能被摊薄成“命中”
    const next = makeTextured((row) => (row === 0 ? [250, 5, 250] : rowColor(row)));
    expect(stickyTopFromData(prev, next, W, SH, 1)).toBe(0);
  });
});

describe("globalDiff / framesAlike", () => {
  const mkImageData = (d: Uint8ClampedArray): ImageData =>
    ({ data: d, width: W, height: SH, colorSpace: "srgb" }) as ImageData;

  it("完全相同的两帧：差异为 0，判为稳定", () => {
    const a = makeFrame(rowColor);
    const b = makeFrame(rowColor);
    expect(globalDiff(a, b)).toBe(0);
    expect(framesAlike(mkImageData(a), mkImageData(b))).toBe(true);
  });

  it("滚动过的两帧：差异超阈，判为未稳定", () => {
    const a = makeFrame(rowColor);
    const b = scrolled(15);
    expect(globalDiff(a, b)).toBeGreaterThan(GLOBAL_DIFF_T);
    expect(framesAlike(mkImageData(a), mkImageData(b))).toBe(false);
  });

  it("长度不等时不崩，当作“完全不同”处理", () => {
    const a = makeFrame(rowColor);
    const b = new Uint8ClampedArray(8);
    expect(globalDiff(a, b)).toBe(Number.POSITIVE_INFINITY);
    expect(framesAlike(mkImageData(a), mkImageData(b))).toBe(false);
  });

  it("空数据不会除零得到 NaN", () => {
    expect(globalDiff(new Uint8ClampedArray(0), new Uint8ClampedArray(0))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
