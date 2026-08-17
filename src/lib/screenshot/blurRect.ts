/**
 * 模糊采样矩形的 padding 计算（纯函数）。
 *
 * 为什么需要它：`ctx.filter = blur(r)` 的卷积在画布边界处要采样边界**外**的像素，
 * 而那里什么都没有 → alpha 被拉低 → 模糊块四周一圈发虚、透出原图。
 *
 * 旧实现的注释说“用不透明临时画布解决了”——那只诊对了现象，没诊对原因。
 * 问题不在临时画布内部是不是透明，而在它**外部没有像素**。
 *
 * 解法（业界标准）：从底图采样时向外多取 `radius * 2` 的边距，模糊完再把边距裁掉。
 * 底图是全屏的，选区周围真的有像素可用。
 *
 * 但选区贴屏幕边缘时，向外扩会超出底图——`drawImage` 对超出源图的部分按
 * 透明处理，那一侧照样羽化。所以必须把采样矩形**钉到底图边界内**，
 * 并记住每一侧实际拿到的边距（四侧可能不等），回贴时按它取偏移。
 */

export interface BlurSample {
  /** 从底图采样的矩形（底图坐标） */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** 实际拿到的边距（四侧独立，贴边时会小于请求值） */
  padL: number;
  padT: number;
}

/**
 * 算出带 padding 的采样矩形。
 *
 * @param x/y/w/h  要模糊的区域（**底图坐标**，调用方已经加好 offX/offY）
 * @param radius   模糊半径
 * @param baseW/H  底图尺寸
 */
export function blurSampleRect(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  baseW: number,
  baseH: number,
): BlurSample {
  const pad = Math.ceil(Math.max(0, radius) * 2);

  // 逐侧钉：左/上不能小于 0，右/下不能超过底图。
  // 四侧得分开算，不能取一个统一的 pad —— 选区贴左边时左侧 pad 为 0，
  // 但右侧仍然能拿到完整的 pad，取最小值会白白丢掉右侧那一圈真像素。
  const padL = Math.min(pad, Math.max(0, x));
  const padT = Math.min(pad, Math.max(0, y));
  const padR = Math.min(pad, Math.max(0, baseW - (x + w)));
  const padB = Math.min(pad, Math.max(0, baseH - (y + h)));

  return {
    sx: x - padL,
    sy: y - padT,
    sw: w + padL + padR,
    sh: h + padT + padB,
    padL,
    padT,
  };
}
