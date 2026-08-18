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
 * 吸顶带的「有东西」下限：带内相邻采样点的平均亮度差（三通道和）。
 *
 * 为什么需要它：纯色带（空白、纯背景、大片同色面板）在两帧里当然逐行一致，
 * 但它不是吸顶导航。把它当吸顶带剔掉，丢的是**真内容**（而且静默）——
 * 对拼接工具来说这是最糟的失败模式，所以宁可漏检不可过检。
 */
export const STICKY_MIN_STRUCTURE = 12;

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
 * @param topSkip 吸顶带高度（原图像素）：next 的比较起点从这一行之后开始，
 *                避免被固定导航/表头这种「每帧都长一样的顶部带」污染重叠匹配
 * @returns 重叠行数；0 表示“画面未变化 / 未找到重叠”
 */
export function overlapRowsFromData(
  d1: Uint8ClampedArray,
  d2: Uint8ClampedArray,
  W: number,
  sh: number,
  scale: number,
  topSkip = 0,
): number {
  // 全局变化检测：几乎未变 → 视为滚动到底 / 内容静止
  if (globalDiff(d1, d2) < GLOBAL_DIFF_T) return 0;

  // topSkip 折算到小图行数；next 的匹配起点整体下移，prev 底部不变。
  const topScaled = Math.max(0, Math.min(sh - 4, Math.round(topSkip * scale)));
  // 可用匹配窗口不能越过小图底部，且要为 prev 底部留出 k 行
  const maxK = Math.min(Math.floor(sh * 0.6), 90, sh - topScaled - 1);
  if (maxK < 3) return 0;
  for (let k = maxK; k >= 3; k--) {
    let diff = 0;
    let cnt = 0;
    for (let row = 0; row < k; row++) {
      const pr = (sh - k + row) * W * 4; // prev 底部第 row 行
      const nr = (topScaled + row) * W * 4; // next 跳过吸顶带后的第 row 行
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
  topSkip = 0,
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
  return overlapRowsFromData(d1, d2, W, sh, scale, topSkip);
}

/**
 * 吸顶带检测（纯数据版，可单测）：返回 next 顶部与 prev 顶部**逐行相同**的带高（原图像素）。
 *
 * 用途：固定导航栏 / 表头 / 吸顶按钮这类元素在每帧截图里都停在同一位置，
 * 拼接时若不剔除，会在长图里反复出现一条重复带、并在 seam 处错位。
 * 判据（两道关，缺一不可）：
 *  1. **逐行连续**：从第 0 行往下一行一行比，碰到第一行不一致就停。
 *     ❌ 不能像旧实现那样取「整带均值」再从最大 k 往下找首个命中：均值会让一两行
 *     差得很远的行被其余几十行摊薄，而“取最大 k”又天然偏向报大。
 *  2. **带内要有结构**：纯色带不算吸顶（见 STICKY_MIN_STRUCTURE）。
 *
 * 两道关都是为了同一件事：sticky 报大多少，长图就**静默少拼多少内容**
 * （seam = sticky + overlap），所以宏观上宁可漏检。
 * 限制：带高不超过整图 40%，避免把「整帧都没动」误判成吸顶（那种情况交给 overlap 判到底）。
 */
export function stickyTopFromData(
  d1: Uint8ClampedArray,
  d2: Uint8ClampedArray,
  W: number,
  sh: number,
  scale: number,
): number {
  if (d1.length !== d2.length) return 0;
  const maxStickyScaled = Math.min(Math.floor(sh * 0.4), 60);
  const samples = Math.max(1, Math.ceil(W / 2));
  let k = 0;
  let structure = 0;
  while (k < maxStickyScaled) {
    const base = k * W * 4;
    let diff = 0;
    let cnt = 0;
    let varSum = 0;
    let prevLum = -1;
    for (let col = 0; col < W; col += 2) {
      const i = base + col * 4;
      diff +=
        Math.abs(d1[i] - d2[i]) +
        Math.abs(d1[i + 1] - d2[i + 1]) +
        Math.abs(d1[i + 2] - d2[i + 2]);
      cnt += 3;
      const lum = d1[i] + d1[i + 1] + d1[i + 2];
      if (prevLum >= 0) varSum += Math.abs(lum - prevLum);
      prevLum = lum;
    }
    // 这一行就对不上 → 吸顶带到此为止（不再往下看，保证连续）
    if (cnt === 0 || diff / cnt >= ROW_MATCH_T) break;
    structure += varSum;
    k++;
  }
  if (k === 0) return 0;
  // 纯色带否决：空白/纯背景逐行一致是平常事，把它当吸顶剔掉会静默丢内容。
  if (structure / k / samples < STICKY_MIN_STRUCTURE) return 0;
  return Math.max(1, Math.round(k / scale));
}

/**
 * 吸顶带检测（canvas 版）：把两帧缩到 STITCH_PROBE_W 宽再交给 {@link stickyTopFromData}。
 * 与 findOverlapRows 同源取样，jsdom 下不可用，单测只针对数据版。
 */
export function findStickyTop(
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
  return stickyTopFromData(d1, d2, W, sh, scale);
}

/**
 * 接缝羽化：把 append 顶部的 `feather` 行做 alpha 渐变（0→1）后贴合到目标画布上。
 *
 * ❌ 前提（调用方必须保证）：append 顶部那 `feather` 行必须是与目标画布上
 * `topY .. topY+feather` 处「内容相同」的重叠行，并且 `topY` 要往上叠回去。
 * 只有同一内容互相淡入才叫交叉淡化；若贴在一块**空白**区域上，斜坡混的就是
 * 透明，结果是每条接缝多出一条半透明带——本来想掩盖的瑕疵反而是自己造的
 * （旧实现就是这样：画在 yy 处，而 yy 正好是上一片的结尾，那里什么都没有）。
 *
 * 内容对齐完美时等价于原样（无副作用），有亚像素/色彩漂移时掩盖硬接缝线。
 *
 * @param topY append 的**顶行**落在哪一行（= 新内容起始行 − feather）
 */
export function drawFeathered(
  ctx: CanvasRenderingContext2D,
  append: HTMLCanvasElement,
  topY: number,
  feather: number,
): void {
  if (feather <= 0 || append.height <= feather) {
    ctx.drawImage(append, 0, topY);
    return;
  }
  const w = append.width;
  const h = append.height;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tc = tmp.getContext("2d");
  if (!tc) {
    ctx.drawImage(append, 0, topY);
    return;
  }
  tc.drawImage(append, 0, 0);
  const grad = tc.createLinearGradient(0, 0, 0, feather);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  tc.globalCompositeOperation = "destination-in";
  tc.fillStyle = grad;
  tc.fillRect(0, 0, w, feather);
  tc.fillStyle = "rgba(0,0,0,1)";
  tc.fillRect(0, feather, w, h - feather);
  ctx.drawImage(tmp, 0, topY);
}

/**
 * 每侧最多裁掉该方向尺寸的这个比例（下限 8px）。
 *
 * ❌ 没有上限是危险的：白底网页 / Word / 白底文档的**页边距本来就是整列全白**，
 * 一路吃到第一列有字的地方，用户选的选区就被静默改了几何。
 * 而这个功能要解决的只是「选区比窗口略大带入的桌面白边」——那是**薄薄一条**。
 * 取不到就算了（少裁一点无害），多裁则是丢内容。
 */
export const CROP_MAX_RATIO = 0.03;
/** 超过这么多像素的图不做裁白边：一次 getImageData 要把整幅 RGBA 拉进内存（w×h×4 字节）。 */
export const CROP_MAX_PIXELS = 40_000_000;

/**
 * 自动裁白边：去掉成图四周「整行/整列全白」的留白（如选区比窗口略大时带入的桌面白边）。
 * 只裁**连续到边缘**的全白边，内容内部的白区不受影响。无白边则返回原图。
 * 每侧裁切量有上限（见 CROP_MAX_RATIO）；图太大则直接跳过（见 CROP_MAX_PIXELS）。
 */
export function cropWhiteMargins(src: HTMLCanvasElement, threshold = 248): HTMLCanvasElement {
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;
  const w = src.width;
  const h = src.height;
  if (w === 0 || h === 0) return src;
  // 长图动辄上万像素高，整幅 getImageData 既耗时又吃内存，还可能直接抛。
  // 裁白边只是锦上添花，不值得为它冒丢掉整轮长截图的风险。
  if (w * h > CROP_MAX_PIXELS) return src;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return src; // 取不到像素（超大画布/安全限制）就不裁，不能让整张长图挂掉
  }
  const whiteRow = (y: number) => {
    const base = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = base + x * 4;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) return false;
    }
    return true;
  };
  const whiteCol = (x: number) => {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) return false;
    }
    return true;
  };
  // 每侧裁切上限：宁可少裁不可多裁（见 CROP_MAX_RATIO 的注释）。
  const maxV = Math.max(8, Math.floor(h * CROP_MAX_RATIO));
  const maxH = Math.max(8, Math.floor(w * CROP_MAX_RATIO));
  let top = 0;
  let bottom = h - 1;
  let left = 0;
  let right = w - 1;
  while (top <= bottom && top < maxV && whiteRow(top)) top++;
  while (bottom > top && h - 1 - bottom < maxV && whiteRow(bottom)) bottom--;
  while (left <= right && left < maxH && whiteCol(left)) left++;
  while (right > left && w - 1 - right < maxH && whiteCol(right)) right--;
  if (top === 0 && bottom === h - 1 && left === 0 && right === w - 1) return src;
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d");
  if (!octx) return src;
  octx.drawImage(src, left, top, cw, ch, 0, 0, cw, ch);
  return out;
}
