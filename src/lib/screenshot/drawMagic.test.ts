import { describe, it, expect } from "vitest";
import { magicMaskFromSeeds, MAGIC_WAND_TOL } from "./draw";

/** 造一张图：左侧一大块浅灰 watermark 区（统一色 200），右侧深色背景（50），
 * 中间一条不同色（100）分隔。种子点在 watermark 区内，魔棒应吸附整片 200 区，
 * 不越过 100 分隔、不碰 50 背景。 */
function buildImage(bw: number, bh: number) {
  const img = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (y * bw + x) * 4;
      let v = 50; // 背景
      if (x >= 10 && x < 40)
        v = 200; // watermark 区
      else if (x >= 40 && x < 45) v = 100; // 分隔
      img[i] = v;
      img[i + 1] = v;
      img[i + 2] = v;
      img[i + 3] = 255;
    }
  }
  return img;
}

/** 纯色填充的单行图，专用于容差边界断言 */
function grayRow(values: number[]) {
  const bw = values.length;
  const img = new Uint8ClampedArray(bw * 4);
  values.forEach((v, x) => {
    img[x * 4] = v;
    img[x * 4 + 1] = v;
    img[x * 4 + 2] = v;
    img[x * 4 + 3] = 255;
  });
  return img;
}

describe("magic 魔棒吸附", () => {
  it("从 watermark 区内种子吸附整片同色连通区，不越分隔/背景", () => {
    const bw = 60,
      bh = 20;
    const img = buildImage(bw, bh);
    // 种子：watermark 区中心一小块
    const seed = new Uint8Array(bw * bh);
    for (let y = 5; y < 15; y++) for (let x = 20; x < 30; x++) seed[y * bw + x] = 1;

    const mask = magicMaskFromSeeds(img, bw, bh, seed, MAGIC_WAND_TOL, bw * bh);

    // watermark 区 (x 10..40) 应全被选中
    for (let y = 0; y < bh; y++) {
      for (let x = 10; x < 40; x++) expect(mask[y * bw + x]).toBe(1);
    }
    // 分隔 (40..45) 与背景 (<10, >=45) 不应被选
    for (let y = 0; y < bh; y++) {
      for (let x = 45; x < bw; x++) expect(mask[y * bw + x]).toBe(0);
      for (let x = 0; x < 10; x++) expect(mask[y * bw + x]).toBe(0);
    }
  });

  it("无种子返回空蒙版", () => {
    const bw = 10,
      bh = 10;
    const img = buildImage(bw, bh);
    const mask = magicMaskFromSeeds(img, bw, bh, new Uint8Array(bw * bh), MAGIC_WAND_TOL, bw * bh);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("maxGrow 防御生效：生长恰好停在上限，不会吸走整片同色区", () => {
    // 生产调用点传的是 max(1024, 面积/2)（审查 L-2：旧代码传 bw*bh 形同虚设）；
    // 这里用小上限直接锁死"到上限即停"的语义。
    const bw = 60,
      bh = 20; // watermark 连通区共 30×20=600px
    const img = buildImage(bw, bh);
    const seed = new Uint8Array(bw * bh);
    seed[10 * bw + 20] = 1; // watermark 区内单种子
    const CAP = 50;

    const mask = magicMaskFromSeeds(img, bw, bh, seed, MAGIC_WAND_TOL, CAP);

    const count = mask.reduce((a, b) => a + b, 0);
    expect(count).toBe(CAP);
    expect(count).toBeLessThan(600);
  });

  it("容差边界：色差恰等于 tol 仍吸附，tol+1 不吸附", () => {
    // 种子色 200；x=4 差 28（=MAGIC_WAND_TOL，边界内）；x=5 差 29（出界）
    const img = grayRow([200, 200, 200, 200, 228, 229]);
    const seed = new Uint8Array(6);
    seed[0] = 1;

    const mask = magicMaskFromSeeds(img, 6, 1, seed, MAGIC_WAND_TOL, 6);

    expect(mask[4]).toBe(1);
    expect(mask[5]).toBe(0);
  });

  it("种子落在异色区：只吸附种子自己颜色的连通区，不串进相邻水印区", () => {
    const bw = 60,
      bh = 20;
    const img = buildImage(bw, bh);
    const seed = new Uint8Array(bw * bh);
    seed[10 * bw + 42] = 1; // 落在分隔条（色 100）上

    const mask = magicMaskFromSeeds(img, bw, bh, seed, MAGIC_WAND_TOL, bw * bh);

    // 分隔条整列被选中
    for (let y = 0; y < bh; y++) expect(mask[y * bw + 42]).toBe(1);
    // 左侧水印（差 100）、右侧背景（差 50）都超出 tol，不受波及
    for (let y = 0; y < bh; y++) {
      expect(mask[y * bw + 39]).toBe(0);
      expect(mask[y * bw + 45]).toBe(0);
    }
  });
});
