/**
 * 去水印（路线 A'）核心算法：纯像素函数，不依赖 canvas / DOM，可在 Node / jsdom 下单测。
 *
 * 核心思想：频域周期提取 + 逐像素减回（不是 inpaint 猜，是还原）。
 *
 * 半透明规则水印（企业微信 / 钉钉 / 飞书）是图层叠加：I = (1−α)·O + α·W。
 * 对灰度图做 2D FFT，水印的周期性在频域表现为尖峰（任意方向，含斜排——天然解决
 * 旧方案「投影自相关」只能轴对齐、对斜排漏检的问题），背景不周期 → 能量分散不入峰。
 * 只保留频域主峰（+谐波+共轭）做 IFFT → 得水印扰动层 Lp ≈ α·(W−O)。
 * 逐像素 O = I − gain·Lp 即还原真实像素：零模糊、零猜测、不误伤背景
 * （背景不周期 → Lp≈0 → O≈I 原样保留，聊天文字/头像完好）。
 *
 * 相比旧路线 A 的 inpaint 盲去法（用「原图−背景」差找水印像素再 inpaint）：
 *   - 不会误伤（文字/头像不周期，不在频域峰，Lp≈0，原样保留）
 *   - 不会漏检（FFT 天然处理斜排，不像投影自相关只能轴对齐）
 *
 * 手动模式（非平铺）：用户框选局部块，块内含周期则同样频域减回；块太小估不出周期
 * （单块不规则 logo）→ 退回 inpaint 兜底（仅框内，不误伤全图）。
 *
 * 依赖：零新增（纯 JS + Canvas RenderingContext 仅前端调用方用）。离线、不触 ai_enabled。
 */

// 中值叠瓦去水印（轴对齐 + 斜向）：平铺周期水印的还原式去法，探针验证优于本文件旧 FFT。
import { estimateWatermarkPeriod, removeWatermarkByTiling } from "./watermarkMedian";
import { estimateObliqueWatermark, removeDiagonalWatermarkByTiling } from "./watermarkMedianDiagonal";

export interface GrayImage {
  gray: Float32Array;
  w: number;
  h: number;
}

/**
 * RGBA → 灰度降采样。maxW 限制降采样宽（默认 320），高度按等比例。
 * 亮度用 Rec.601（0.299/0.587/0.114）。纯函数，返回新数组。
 */
export function downsampleGray(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  maxW = 320,
): GrayImage {
  const scale = w > 0 ? Math.min(1, maxW / w) : 1;
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const gray = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y / dh) * h));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x / dw) * w));
      const i = (sy * w + sx) * 4;
      gray[y * dw + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  return { gray, w: dw, h: dh };
}

// ──────────────────────────── 2D FFT（radix-2，纯函数） ────────────────────────────

/** 迭代 radix-2 1D FFT（长度必须是 2 的幂）。re/im 原地修改。 */
export function fft1d(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // bit-reversal 置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 迭代 radix-2 1D IFFT = 共轭 FFT / N。re/im 原地修改。 */
function ifft1d(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft1d(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

/** 2D FFT：先行、后列。size 必须是 2 的幂。原地修改 re/im。 */
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

/** 2D IFFT：列 IFFT 后行 IFFT。原地修改 re/im。 */
function ifft2d(re: Float64Array, im: Float64Array, size: number): void {
  for (let y = 0; y < size; y++) {
    ifft1d(re.subarray(y * size, y * size + size), im.subarray(y * size, y * size + size));
  }
  const colRe = new Float64Array(size);
  const colIm = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      colRe[y] = re[y * size + x];
      colIm[y] = im[y * size + x];
    }
    ifft1d(colRe, colIm);
    for (let y = 0; y < size; y++) {
      re[y * size + x] = colRe[y];
      im[y * size + x] = colIm[y];
    }
  }
}

/**
 * 频域「水印峰」过滤：只保留「二维格点 + 基频整数倍」的峰，其余置 0。
 * 返回是否认定存在平铺水印。
 *
 * 判据按真实截图重做过（企业微信聊天窗 850×640，频谱实测）：
 *  1) **二维分量下限（WM_F_MIN）** —— 最关键的一道。平铺水印是二维格点，fx/fy 都非零；
 *     而聊天行/分割线/面板边界这类水平条纹能量全落在 fx=0、1（实测最强的十几个峰
 *     如 (0,8) 2.45、(1,6) 2.20 全在那里）。先把它们排开，水印才能浮上水面。
 *  2) **格点一致性**：在合格区域取最强峰作基频，只留它的整数倍（isHarmonic）。
 *     实测水印基频 (2,6) 1.45、二倍频 (2,12) 1.18（水印单元是两行文字，所以 y
 *     方向多一个 2 倍频）；而内容的 (2,2) 1.39、(2,3) 1.37、(3,5) 1.10 不是它的倍数 → 丢。
 *     幅值在这里根本分不开两者（1.45 vs 1.39），只有结构能。
 *  3) **成员数（WM_MIN_MEMBERS）**：至少基频 + 1 个谐波。孤峰不算，否则就是拿
 *     内容里碰巧较强的某个结构去减真内容。
 *  4) 幅值区间与连通簇大小保留为后备（防噪声旁瓣与宽峰）。
 *
 * ❗ 已知天花板一（alpha 混合）：水印是 alpha 混合叠上去的，不是等量相加 —— 在白气泡上
 * 是浅灰，在深色气泡上几乎看不见。频域减回假设的是空间均匀的加性层，所以深色区
 * 会欠减、浅色区可能过减。对“淡水印 + 大面积浅底”能做得不错，但做不到完美。
 *
 * ❗ 已知天花板二（**分辨率**，比上面那条更硬）：fx/fy 的单位是“每选区周期数”，
 * 不是像素。把选区降采到 size×size 并不能提高这个分辨率 —— 探针实测 size=256 / 512 /
 * 1024 算出的峰位置与幅值几乎一模一样（(2,2) 0.989 / 0.964 / 0.965）。
 * 而常见水印瓦片 ~150～250px、选区 ~850px，所以基频必然落在 **bin 2～5**，
 * 而频谱泄露就有 ±1 bin。在这个尺度上“基频、二倍频、内容峰”本身就区分不开（见
 * isHarmonic 的退化说明）。这不是调参能解决的，是方法的上限；要再进一步得换空间域
 * 思路（自相关估瓦片周期 → 按瓦片叠起求中值估水印层），不是接着拧频域阈值。
 */
const WM_AMP_FLOOR = 0.5; // 每像素幅值下限：低于视为噪声旁瓣
/** 每像素幅值上限。
 *
 * 它本意是“幅值太大的当内容周期丢弃”，但实测（企业微信聊天窗 850×640）
 * 内容条纹幅值只有 2.3、水印基频 1.45 —— 离 12 差 5 倍，**这道门从未生效**。
 * 现在靠下面的 fx/fy≥2 + 格点判据排内容，它只当一道宽松的后备。 */
const WM_AMP_CEIL = 12;
/** 径向频域上限（单位：FFT bin）。
 *
 * ❗ 旧值是 6，那是个真 bug：实测企业微信水印的两个主峰是 (2,6) 与 (2,12)，
 * 径向 k = √40 = 6.32 与 √148 = 12.2，**恰好卡在 6 外面全被切掉**；
 * 而通过的 62 个候选全是 (0,8)/(1,6)/(2,2)/(2,3) 这类聊天行条纹。
 * 于是去水印实际在做的是“减掉内容、保留水印”——正好反了。
 * 抬到 48 才能装下基频与前几个谐波；安全前提是下面的 WM_F_MIN。 */
const WM_K_MAX = 48;
/** 二维分量下限：一级搜索要求 fx 与 fy **都** ≥ 它。
 *
 * 为什么是这道门：实测两个样本都显示**内容住在轴上、水印在轴外**。
 *   · 真实企业微信截图：最强的十几个峰 (0,8) 2.45、(1,6) 2.20… 全在 fx≤1；
 *     水印在 (2,6) 1.45。
 *   · 单测混合样例：强内容的谐波 (10,0) 57、(14,0) 11.9、(6,0) 8.9 全在 fy=0；
 *     水印在 (3,3) 1.71。
 * 只卡 fx 不卡 fy 的话，混合样例里 (14,0) 11.9 会被选为基频（远大于水印 1.71），
 * 于是去水印变成减内容。 */
const WM_F_MIN = 2;
/** 二级（轴向）搜索的幅值上限。
 *
 * 一级找不到轴外格点时才跑：允许纯轴向的周期（“沿 x 周期、沿 y 恒定”的竖条纹
 * 水印，或用户只框了一条窄横带、里面只有一行水印），但**必须很弱**。
 *
 * 道理：轴向周期本质上区分不了水印与内容（UI 的行/列就是轴向周期），
 * 唯一可用的线索是强弱：强的轴向周期几乎还是内容。阈值 3 把单测 1-D 样例
 * 的 0.906 放进来，把混合样例的 5.9~57 挡在外面。 */
const WM_AXIS_AMP_CEIL = 3;
/** 4-连通候选分量的最大 bin 数。格点门控后候选集已经很稀，这里只防宽峰；
 *  高阶谐波的泄漏会占好几个 bin（实测 fy 21~23 都有能量），所以从 4 抬到 12。 */
const MAX_CLUSTER = 12;
/** 认定为平铺水印需要的格点成员数（基频 + 谐波）。 */
const WM_MIN_MEMBERS = 2;
/** 孤峰的放行条件：基频幅值至少是“非格点最强峰”的这么多倍。
 *
 * 为什么需要这个出口：**纯周期水印根本没有谐波**（单一正弦），只要求“基频+谐波”
 * 会把它们全挡掉。而文字水印不是正弦、天然有谐波，走成员数那条。
 * 两条取或：要么有格点结构，要么孤峰强得明显——都不满足就不减。 */
const WM_LONE_MARGIN = 1.3;

/**
 * v 是不是 base 的正整数倍（带相对容差）。
 *
 * 容差用相对而不是固定 ±1：固定容差在低频处太松。实测 (3,5) 是内容（amp 1.10），
 * 若用 ±1 它会被当成 (2,6) 的倍数放进来；相对容差下 fx=3 vs 2×2=4 的偏差 1
 * 超过阈值，正好剔掉。而 (2,11)/(2,22) 这类高阶谐波的泄漏仍能被包进来。
 *
 * ⚠ 这里的系数（0.35 / 0.2）是在**两个样本**上拟出来的：一张真实企业微信截图
 * 与单测里的合成样例。不是推导出来的最优值，换一类水印可能要重新标定。
 *
 * ⚠⚠ 已知退化：**base ≤ 3 时这个判据基本不起作用**。谐波间距就是 base，而 n≥3 的
 * 容差 0.2·n·base 在 base=2 时已经 ≥1.2 > base/2 —— 相邻谐波带互相重叠，于是
 * 除了 v=3（落在 n=2 的窄带外）之外，所有 v≥4 一律放行。
 * 实测（企业微信 848×939 选区）基频落在 (2,2)，格点过滤等于没做，水印是靠
 * 「轴外 + WM_K_MAX」这两道减掉的，不是靠格点。见文件头「分辨率天花板」。
 */
function isHarmonic(v: number, base: number): boolean {
  // 基频该分量为 0（沿这个方向不变，比如“沿 x 周期、沿 y 恒定”的竖条纹）：
  // 合法的倍数只有 0。
  // ❗ 早先写的是 `if (base <= 0) return false`，把**基频自己**都判否了，
  //   于是 1-D 周期水印一个 bin 都留不下。
  if (base <= 0) return v <= 1;
  const n = Math.round(v / base);
  if (n < 1) return false;
  // 容差按 base 按比例给，不能用固定值：
  //  · n=1（基频本体）放宽一点，把**频谱泄漏**包进来 —— 真实周期很少正好落在
  //    整数 bin 上（样例周期 24 / 格子 64 = 2.67），不包泄漏就既凑不够成员数、
  //    也拿不到幅值优势；
  //  · n≥2（谐波）按 n·base 按比例放宽，高阶泄漏本来就散。
  // 比例而非绝对值是关键：base=2 时 ±1 会把内容峰 (3,5) 放进来（实测）。
  const tol = n === 1 ? Math.max(0.5, 0.35 * base) : Math.max(0.5, 0.2 * n * base);
  return Math.abs(v - n * base) <= tol;
}

function keepPeaks(re: Float64Array, im: Float64Array, size: number): boolean {
  const n = size * size;
  const mag = new Float64Array(n);
  for (let i = 0; i < n; i++) mag[i] = Math.hypot(re[i], im[i]);
  const norm = size * size;
  // 频率 = 距 DC 的回绕距离（FFT 未做 fftshift）
  const fxOf = (x: number) => (x <= size / 2 ? x : size - x);
  const fyOf = (y: number) => (y <= size / 2 ? y : size - y);
  /** 进入格点判定的基本门。axis=false 是一级（轴外格点），axis=true 是二级（允许轴向但要很弱）。 */
  const eligibleIn = (i: number, fx: number, fy: number, axis: boolean): boolean => {
    if (i === 0) return false; // DC（水印零均值）
    if (Math.hypot(fx, fy) > WM_K_MAX) return false;
    const amp = mag[i] / norm;
    if (amp < WM_AMP_FLOOR) return false;
    if (axis) {
      // 二级：只要不是 DC 十字中心，但幅值必须很小
      if (fx < WM_F_MIN && fy < WM_F_MIN) return false;
      return amp <= WM_AXIS_AMP_CEIL;
    }
    // 一级：必须是轴外格点（两个分量都够大）
    if (fx < WM_F_MIN || fy < WM_F_MIN) return false;
    return amp <= WM_AMP_CEIL;
  };

  // ① 先找候选基频：一级（轴外）优先，找不到才降级到二级（轴向但很弱）。
  //   为什么一级能找准水印：内容的主能量都在轴上，被轴外要求排掉了，
  //   剩下的轴外区域里水印就是最强的（实测 (2,6) 1.45 对内容 (2,2) 1.39）。
  let fx0 = 0;
  let fy0 = 0;
  let best = 0;
  let axisMode = false;
  const findFundamental = (axis: boolean): boolean => {
    let b = 0;
    let bx = 0;
    let by = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const fx = fxOf(x);
        const fy = fyOf(y);
        if (!eligibleIn(i, fx, fy, axis)) continue;
        const amp = mag[i] / norm;
        if (amp > b) {
          b = amp;
          bx = fx;
          by = fy;
        }
      }
    }
    if (b <= 0) return false;
    best = b;
    fx0 = bx;
    fy0 = by;
    axisMode = axis;
    return true;
  };
  /** 轴上（fx 或 fy 小于下限）的最大幅值。
   *
   * 用它给二级降级加前提：**整幅图里根本不存在强轴向结构时，才允许把轴向周期
   * 当水印**。否则强轴向内容的**高阶谐波与重采样泄漏**会正好掉进
   * [WM_AMP_FLOOR, WM_AXIS_AMP_CEIL] 这个窗口里，被认成弱水印（实测：周期 6、
   * 幅值 50 的横条纹，基频约 31.8，而 11 次谐波约 2.9 —— 恰好≤ 3）。 */
  let maxAxisAmp = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (i === 0) continue;
      const fx = fxOf(x);
      const fy = fyOf(y);
      if (fx >= WM_F_MIN && fy >= WM_F_MIN) continue; // 轴外，不算
      if (fx < WM_F_MIN && fy < WM_F_MIN) continue; // DC 十字中心
      const amp = mag[i] / norm;
      if (amp > maxAxisAmp) maxAxisAmp = amp;
    }
  }
  const axisAllowed = maxAxisAmp <= WM_AXIS_AMP_CEIL;
  // ❗ 判“没找到”要看幅值而不是看 fx0/fy0：轴向基频的某个分量就是 0，
  //   早先写的 `if (!fx0 || !fy0)` 把它当成“没找到”，1-D 周期水印直接全军覆没。
  if (!findFundamental(false) && !(axisAllowed && findFundamental(true))) {
    re.fill(0);
    im.fill(0);
    return false;
  }
  const eligible = (i: number, fx: number, fy: number) => eligibleIn(i, fx, fy, axisMode);

  // ② 只保留基频的**整数倍格点**（含四个象限的共轭，fxOf/fyOf 已经折回）。
  //   这一步才是真正把内容排开的地方：(2,12) 是 (1×2, 2×6) → 留；
  //   而 (2,2)/(2,3)/(3,5) 不是 (2,6) 的倍数 → 丢。光抬 WM_K_MAX 不加这道判据，
  //   它们会跟水印一起被减掉（幅值同量级，分不开）。
  const cand = new Uint8Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fx = fxOf(x);
      const fy = fyOf(y);
      if (!eligible(i, fx, fy)) continue;
      if (!isHarmonic(fx, fx0) || !isHarmonic(fy, fy0)) continue;
      cand[i] = 1;
    }
  }
  // 4-连通分量：只保留小簇（水印尖峰），宽峰整簇丢弃（内容抖动残差）
  const keep = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const stack: number[] = [];
  let hit = false;
  for (let s = 0; s < n; s++) {
    if (!cand[s] || visited[s]) continue;
    stack.length = 0;
    stack.push(s);
    visited[s] = 1;
    let head = 0;
    const comp: number[] = [];
    while (head < stack.length) {
      const p = stack[head++];
      comp.push(p);
      const px = p % size;
      const py = (p / size) | 0;
      const ns = [
        [px - 1, py],
        [px + 1, py],
        [px, py - 1],
        [px, py + 1],
      ];
      for (const [nx, ny] of ns) {
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (cand[j] && !visited[j]) {
          visited[j] = 1;
          stack.push(j);
        }
      }
    }
    if (comp.length <= MAX_CLUSTER) {
      for (const p of comp) keep[p] = 1;
    }
  }
  // ③ 统计保留下来的**不同 (fx,fy)** 个数，而不是 bin 个数：
  //   共轭会让同一个峰占 2~4 个 bin，按 bin 计数的话光基频就凑够 2 个，
  //   WM_MIN_MEMBERS 等于没设。要的是“基频 + 至少一个真谐波”。
  //   同时量一下“没被留下的合格峰”最强是多少，给孤峰出口用。
  const distinct = new Set<string>();
  let maxOff = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fx = fxOf(x);
      const fy = fyOf(y);
      if (keep[i]) {
        distinct.add(`${fx},${fy}`);
      } else if (eligible(i, fx, fy)) {
        const amp = mag[i] / norm;
        if (amp > maxOff) maxOff = amp;
      }
    }
  }
  // 两条取或：有格点结构（文字水印），或者孤峰强得明显（纯正弦水印）。
  hit =
    distinct.size >= WM_MIN_MEMBERS ||
    (distinct.size >= 1 && best >= WM_LONE_MARGIN * maxOff);
  for (let i = 0; i < n; i++) {
    // 没凑够格点成员就全清：宁可不减，也不能拿一个孤峰去减真内容
    if (!hit || !keep[i]) {
      re[i] = 0;
      im[i] = 0;
    }
  }
  return hit;
}

/** 取 ≤ min(256, w, h) 的最大 2 的幂（FFT 要求 2 的幂）。 */
function fftSize(w: number, h: number): number {
  let s = Math.min(256, w, h);
  if (s < 2) s = 2;
  let p = 1;
  while (p * 2 <= s) p <<= 1;
  return Math.max(2, p);
}

/** RGBA → 灰度降采样到 size×size（2 的幂），最近邻。灰度 0..255。 */
function downsampleToPowerOfTwo(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  size: number,
): Float64Array {
  const out = new Float64Array(size * size);
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

/** 双线性放大 src(sw×sh) → dst(dw×dh)。用于把频域水印层从 FFT 尺寸放大回原分辨率。 */
function upsampleBilinear(
  src: Float64Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float64Array {
  const out = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) / dh) * sh - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = Math.max(0, fy - y0);
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) / dw) * sw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = Math.max(0, fx - x0);
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      out[y * dw + x] = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    }
  }
  return out;
}

/**
 * 频域提取水印扰动层 Lp。
 *
 * 步骤：灰度 → 2D FFT → 保留主峰(+谐波+共轭) → 2D IFFT → 实部。
 * 返回零均值周期扰动层（≈ α·(W−O)），背景（不周期）能量已被滤波剔除。
 */
export function estimateWatermarkLayer(gray: Float64Array, size: number): Float64Array {
  const re = Float64Array.from(gray);
  const im = new Float64Array(size * size);
  fft2d(re, im, size);
  keepPeaks(re, im, size);
  ifft2d(re, im, size);
  return re; // 实部即周期扰动层
}

/**
 * 频域检测是否存在显著周期水印（不修改 rgba）。
 * 用于平铺模式前置判断：有峰才执行整屏减回，无峰提示用户切手动。
 */
export function hasPeriodicWatermark(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): boolean {
  const size = fftSize(w, h);
  const gray = downsampleToPowerOfTwo(rgba, w, h, size);
  const re = Float64Array.from(gray);
  const im = new Float64Array(size * size);
  fft2d(re, im, size);
  // keepPeaks 命中「半透明水印幅值区间」的峰才视为存在水印
  return keepPeaks(re, im, size);
}

/**
 * 频域减回主路径：从 rgba 提取周期水印层并逐像素减回。
 * 返回 true 表示提取到显著水印并减回；false 表示无显著周期（调用方应退回 inpaint 兜底）。
 */
function removeWatermarkByFFT(rgba: Uint8ClampedArray, w: number, h: number): boolean {
  const size = fftSize(w, h);
  const gray = downsampleToPowerOfTwo(rgba, w, h, size);
  const re = Float64Array.from(gray);
  const im = new Float64Array(size * size);
  fft2d(re, im, size);
  // 只保留「半透明水印幅值区间」的峰；命中失败（纯内容周期 / 无弱峰）则不减回，
  // 避免把聊天结构当水印减掉（整页发花）。
  const kept = keepPeaks(re, im, size);
  ifft2d(re, im, size);
  if (!kept) return false;
  const lp = re; // 零均值周期扰动层（≈ α·(W−O)）
  const up = upsampleBilinear(lp, size, size, w, h);
  // gain=1 直接减：Lp ≈ α·(W−O)，I − Lp 即还原真实像素。
  // 只保留有限频域峰，重建幅值可能略缩，半透明水印仍可干净去除（手测若欠减可调 gain）。
  // RGB 三通道共用同一灰度层（水印为单色叠加；彩色水印近似 OK，色偏小）。
  const gain = 1.0;
  for (let i = 0; i < w * h; i++) {
    const ii = i * 4;
    const d = gain * up[i];
    rgba[ii] = rgba[ii] - d; // Uint8ClampedArray 自动 clamp 到 [0,255]
    rgba[ii + 1] = rgba[ii + 1] - d;
    rgba[ii + 2] = rgba[ii + 2] - d;
  }
  return true;
}

// ──────────────────────────── inpaint 兜底（仅手动模式、频域无峰时） ────────────────────────────

/**
 * 多轮扩散 inpaint（简化 Telea / texture-fill）。
 *
 * 对 mask[i] > 0 的像素，用其 5×5 邻域内**已知像素**（mask==0 或已填）做距离加权重建；
 * 原图 alpha 保留。反复迭代直到蒙版清空或无进展（最多 maxPass 轮）。
 *
 * @param rgba 选区 RGBA（w*h*4），**原地修改**。
 * @param mask Uint8Array(w*h)，>0 表示需重建。
 * @param feather 边缘羽化半径（物理像素）：蒙版内距边界 <feather 的像素，从重建渐变回原图（柔边）。
 */
export function inpaintRegion(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  mask: Uint8Array,
  feather: number,
): void {
  const N = w * h;
  const filled = new Uint8Array(N);
  for (let i = 0; i < N; i++) filled[i] = mask[i] ? 0 : 1;
  const orig = rgba.slice(); // 羽化阶段需要原始（含水印）像素
  const maxPass = 32;
  for (let pass = 0; pass < maxPass; pass++) {
    let any = false;
    const next = rgba.slice(); // 本轮结果从当前状态复制，只改新填像素
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let ws = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!filled[j]) continue;
            const d2 = dx * dx + dy * dy;
            const wt = 1 / (d2 + 1);
            const ji = j * 4;
            r += next[ji] * wt;
            g += next[ji + 1] * wt;
            b += next[ji + 2] * wt;
            ws += wt;
          }
        }
        if (ws > 0) {
          const ii = i * 4;
          next[ii] = r / ws;
          next[ii + 1] = g / ws;
          next[ii + 2] = b / ws;
          next[ii + 3] = orig[ii + 3]; // alpha 保留
          filled[i] = 1;
          any = true;
        }
      }
    }
    rgba.set(next);
    if (!any) break;
  }
  if (feather > 0) applyFeather(rgba, orig, mask, w, h, feather);
}

/** 蒙版内像素到最近非蒙版像素的欧氏距离（两遍 chamfer 近似）。 */
function maskDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  // 前向（左上 → 右下）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let best = INF;
      if (x > 0) best = Math.min(best, d[i - 1] + 1);
      if (y > 0) best = Math.min(best, d[i - w] + 1);
      if (x > 0 && y > 0) best = Math.min(best, d[i - w - 1] + Math.SQRT2);
      if (x < w - 1 && y > 0) best = Math.min(best, d[i - w + 1] + Math.SQRT2);
      d[i] = best;
    }
  }
  // 后向（右下 → 左上）
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let best = d[i];
      if (x < w - 1) best = Math.min(best, d[i + 1] + 1);
      if (y < h - 1) best = Math.min(best, d[i + w] + 1);
      if (x < w - 1 && y < h - 1) best = Math.min(best, d[i + w + 1] + Math.SQRT2);
      if (x > 0 && y < h - 1) best = Math.min(best, d[i + w - 1] + Math.SQRT2);
      d[i] = best;
    }
  }
  return d;
}

/**
 * 羽化：蒙版内、距边界 < feather 的像素，从重建渐变回原图（柔边）。
 * 语义：dist=feather（深入核心）= 全重建（无水印）；dist→0（最外缘，紧贴原图）= 全原图。
 */
function applyFeather(
  rgba: Uint8ClampedArray,
  orig: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  feather: number,
): void {
  const d = maskDistance(mask, w, h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const dist = d[i];
    if (dist >= feather) continue; // 核心：全重建
    const a = dist / feather; // 0=边界(全原图) → 1=feather深处(全重建)
    const ii = i * 4;
    rgba[ii] = rgba[ii] * a + orig[ii] * (1 - a);
    rgba[ii + 1] = rgba[ii + 1] * a + orig[ii + 1] * (1 - a);
    rgba[ii + 2] = rgba[ii + 2] * a + orig[ii + 2] * (1 - a);
  }
}

/** 分离式 box blur（水平 + 垂直各一遍），用于手动兜底的局部背景估计。 */
function boxBlur(rgba: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r < 1) return rgba.slice();
  const N = w * h;
  const tmp = new Float32Array(N * 4);
  const out = new Float32Array(N * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const j = (y * w + xx) * 4;
        sr += rgba[j]; sg += rgba[j + 1]; sb += rgba[j + 2]; sa += rgba[j + 3]; cnt++;
      }
      const i = (y * w + x) * 4;
      tmp[i] = sr / cnt; tmp[i + 1] = sg / cnt; tmp[i + 2] = sb / cnt; tmp[i + 3] = sa / cnt;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const j = (yy * w + x) * 4;
        sr += tmp[j]; sg += tmp[j + 1]; sb += tmp[j + 2]; sa += tmp[j + 3]; cnt++;
      }
      const i = (y * w + x) * 4;
      out[i] = sr / cnt; out[i + 1] = sg / cnt; out[i + 2] = sb / cnt; out[i + 3] = sa / cnt;
    }
  }
  return Uint8ClampedArray.from(out);
}

/** 连通分量面积过滤：差 > th 标候选，滤掉面积 < minArea 的孤立分量（去单像素边缘误判）。 */
function connectedMask(
  diff: Float32Array,
  w: number,
  h: number,
  th: number,
  minArea: number,
): Uint8Array {
  const N = w * h;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = diff[i] > th ? 1 : 0;
  const visited = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (!mask[s] || visited[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    visited[s] = 1;
    let head = 0;
    while (head < stack.length) {
      const p = stack[head++];
      comp.push(p);
      const px = p % w;
      const py = (p / w) | 0;
      if (px > 0 && mask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1); }
      if (px < w - 1 && mask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && mask[p - w] && !visited[p - w]) { visited[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && mask[p + w] && !visited[p + w]) { visited[p + w] = 1; stack.push(p + w); }
    }
    if (comp.length < minArea) for (const p of comp) mask[p] = 0;
  }
  return mask;
}

/** 手动模式兜底：框内局部背景估计 + 连通分量过滤 + inpaint（仅框内，不误伤全图）。 */
function removeManualFallback(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  feather: number,
): void {
  const bg = boxBlur(rgba, w, h, radius);
  const N = w * h;
  const diff = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const ii = i * 4;
    diff[i] =
      Math.abs(rgba[ii] - bg[ii]) +
      Math.abs(rgba[ii + 1] - bg[ii + 1]) +
      Math.abs(rgba[ii + 2] - bg[ii + 2]);
  }
  const mask = connectedMask(diff, w, h, 26, 8);
  inpaintRegion(rgba, w, h, mask, feather);
}

/**
 * 平铺算法结果质量门：判断处理后是否出现严重伪影（发花/黑块/内容被抹平）。
 *
 * 单一 clip 比例不够：真实稀疏文字水印经中值叠瓦后 clip 常在 0.06~0.10，但视觉上
 * 只是水印变淡、内容并未发花；而强周期内容被误当水印处理时，虽然 clip 也可能超过
 * 0.03，但会把整页结构抹平（对比度骤降）。
 *
 * 因此看「方向梯度保留度」：对处理前后的灰度图分别统计 x/y 方向梯度能量。正常
 * 水印去除后两个方向的梯度能量同升同降、比例接近；若一个方向被抹平（ratio < 0.35）
 * 而另一个方向暴增（ratio > 2.0），说明把某个方向的周期结构当成水印去掉了，并
 * 引入了正交方向噪声。真实水印图不会出现这种极端不对称。
 *
 * ⚠️ 范围声明（别误读上面那句“把整页结构抹平”）：本门只抓**不对称**破坏。
 * rx、ry 一起塌（比如都掉到 0.1）时 maxR = 0.1，不满足 > 2.0，会直接放行。
 * 这是**有意为之**，不是漏洞：对称衰减分不出“内容被糊掉”与“水印被正确去掉”。
 * 反例：一张大片空白的文档截图盖重平铺水印时，梯度能量本来就主要来自水印，
 * 水印一去 rx、ry 很容易双双跌到 0.35 以下 —— 这是**成功**，不是伪影。加一条
 * `maxR < 0.35` 会把这类最需要去水印的图成批误杀，代价远大于收益。
 * “整页被抹平”要拦得靠 clip 比例 / contentCorr 那条线，不在这个函数里。
 *
 * 性能：不物化 w×h 灰度图 —— 2560×1440 下两个 Float64Array 就是 59MB，而本函数
 * 每次去水印最多被调 3 次（轴对齐 / 斜向 / FFT 各一次），就是 177MB 瞬时分配。
 * 改为逐行流式：灰度即算即用，只留一行 Float32 做上下差分（w 个 float），
 * 同时把原来的 4 趟全图遍历合成 2 趟。结果与旧实现逐项等价。
 */
function hasSevereArtifact(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  orig: Uint8ClampedArray,
): boolean {
  /** 方向梯度能量。逐行扫一遍 px，只保留上一行灰度用于纵向差分。 */
  const gradEnergy = (px: Uint8ClampedArray): { gx: number; gy: number } => {
    let gx = 0;
    let gy = 0;
    let prevRow = new Float32Array(w);
    let curRow = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      const base = y * w * 4;
      for (let x = 0; x < w; x++) {
        const ii = base + x * 4;
        const g = (px[ii] + px[ii + 1] + px[ii + 2]) / 3;
        curRow[x] = g;
        if (x > 0) {
          const d = g - curRow[x - 1];
          gx += d * d;
        }
        if (y > 0) {
          const d = g - prevRow[x];
          gy += d * d;
        }
      }
      // 两行缓冲互换，不重新分配
      const t = prevRow;
      prevRow = curRow;
      curRow = t;
    }
    return { gx, gy };
  };
  const gb = gradEnergy(orig);
  const ga = gradEnergy(rgba);
  const rx = gb.gx > 0 ? ga.gx / gb.gx : 1;
  const ry = gb.gy > 0 ? ga.gy / gb.gy : 1;
  const minR = Math.min(rx, ry);
  const maxR = Math.max(rx, ry);

  // 真正发花/结构破坏：方向梯度严重不对称（一个方向内容被抹平、另一个方向
  // 噪声暴增）。普通水印减弱后两个方向梯度能量同升同降，不会出现这种极端不对称。
  // （只有这一条判据；为什么不加“对称抹平”见上方范围声明。）
  if (minR < 0.35 && maxR > 2.0) return true;
  return false;
}

/**
 * 去水印主入口（平铺 / 手动统一）。原地修改 rgba。
 *
 * 两层平铺算法（轴对齐中值叠瓦 + 斜向中值叠瓦）专治「重复周期水印」
 * （企业微信/钉钉/飞书式网格、斜排文字阵），已在 watermarkMedian / watermarkMedianDiagonal
 * 探针验证完胜旧 FFT 频域减回（watermarkCorr 0.12 vs 0.27、内容保全 0.97 vs 0.92）。
 * 旧 FFT 仍保留为**最后兜底**（仅当两套中值叠瓦都判为「非周期/不可信」时回退），
 * 避免真实场景回归。手动模式（tiled:false）始终走 inpaint 兜底（框内，不误伤全图）。
 *
 * @param opts.tiled 平铺模式（自适应提取整屏周期层减回）；false=手动（用户框选块）。
 * @param opts.feather 边缘羽化半径（物理像素）；仅 inpaint 兜底使用（周期减回逐像素精确无需羽化）。
 * @param opts.radius 手动 inpaint 兜底的背景估计平滑半径（物理像素）。
 * @returns 是否执行了去水印（false=平铺模式三套算法均无显著周期，调用方应提示切手动）。
 */
export function removeTiledWatermarkRegion(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: { tiled: boolean; feather: number; radius: number },
): boolean {
  if (opts.tiled) {
    const orig = rgba.slice();

    // ① 轴对齐平铺水印：2D 自相关估周期 → 中值叠瓦减回（合成探针 watermarkCorr≈0.12）。
    const period = estimateWatermarkPeriod(rgba, w, h);
    if (period && removeWatermarkByTiling(rgba, w, h, period) && !hasSevereArtifact(rgba, w, h, orig)) {
      return true;
    }
    rgba.set(orig); // 轴对齐失败或产生伪影：恢复原图再试斜向

    // ② 斜向重复水印（文字阵等）：剪切扫描估水平周期 + 斜率 → 剪切后水平相位中值减回。
    const oblique = estimateObliqueWatermark(rgba, w, h);
    if (
      oblique &&
      removeDiagonalWatermarkByTiling(rgba, w, h, oblique.tx, oblique.shearK) &&
      !hasSevereArtifact(rgba, w, h, orig)
    ) {
      return true;
    }
    rgba.set(orig); // 斜向失败或产生伪影：恢复原图再试 FFT 兜底

    // ③ 最后兜底：旧 FFT 频域减回（仅当两套中值叠瓦都判「非周期/不可信」）。
    if (removeWatermarkByFFT(rgba, w, h) && !hasSevereArtifact(rgba, w, h, orig)) {
      return true;
    }

    // 三套算法都失败（或产生严重伪影）：恢复原图，让调用方提示用户切手动 / OCR 自动。
    rgba.set(orig);
    return false;
  }
  // 手动模式：用户已框选明确范围，直接 inpaint 兜底（框内，不误伤全图）。
  // 不先走周期减回：非周期单块（logo）的周期重建会残留振铃，inpaint 逐像素重建更干净。
  removeManualFallback(rgba, w, h, opts.radius, opts.feather);
  return true;
}
