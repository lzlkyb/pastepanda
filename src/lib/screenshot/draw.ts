/**
 * 标注绘制：把一个 Annotation 画到 2D context 上。
 *
 * 从 ScreenshotOverlay 抽出的关键理由：annotCanvas 的实时预览与最终合成
 * **共用同一份实现**。两边一旦分叉，就会出现「预览看着对、导出的图不对」
 * 这类最难查的问题——所以它必须是一个独立、无组件状态依赖的纯绘制函数。
 */

import { blurSampleRect } from "./blurRect";
import { maskBox, maskBrushWidth } from "./maskGeom";
import { removeTiledWatermarkRegion, inpaintRegion } from "./dewarp";
import type { Annotation } from "./types";

/**
 * 魔棒遮罩：从笔刷路径覆盖的种子像素出发，泛洪生长「颜色相近」的连通区。
 * 用于手动去水印的「magic」形状——水印是均匀半透明叠色，刷过一处即吸附整条水印文字，
 * 不必沿斜向文字逐笔描。返回与图像同尺寸的 0/1 蒙版（1=待去水印）。
 *
 * @param img      底图 box 区域像素（RGBA）
 * @param bw,bh    区域宽高
 * @param seedMask 笔刷路径覆盖到的像素（1=种子），来自 strokeBrushPath 栅格化
 * @param tol      颜色容差（0~255 每通道）
 * @param maxGrow  最大生长像素数（防御：避免整图纯色背景被一次吸走）
 */
/** 魔棒颜色容差（每通道 0~255）。原先是调用点内联的 28，提出来供测试与调用方共用。 */
export const MAGIC_WAND_TOL = 28;
export function magicMaskFromSeeds(
  img: Uint8ClampedArray,
  bw: number,
  bh: number,
  seedMask: Uint8Array,
  tol: number,
  maxGrow: number,
): Uint8Array {
  const N = bw * bh;
  const out = new Uint8Array(N);
  // 先收集种子像素的代表色：对全部种子取 RGB 均值，靠种子数量摊平单点噪声。
  // （注释曾写"亮度中位数"与实现不符；均值实现更简单，抗离群种子能力弱些，
  //   若日后发现误吸附可再换真正的中位数。）
  let sr = 0, sg = 0, sb = 0, sn = 0;
  const seeds: number[] = [];
  for (let i = 0; i < N; i++) {
    if (seedMask[i]) {
      const ii = i * 4;
      sr += img[ii]; sg += img[ii + 1]; sb += img[ii + 2]; sn++;
      seeds.push(i);
    }
  }
  if (sn === 0) return out;
  const tr = sr / sn, tg = sg / sn, tb = sb / sn;
  const visited = new Uint8Array(N);
  const stack = seeds.slice();
  for (const s of seeds) visited[s] = 1;
  let grown = 0;
  while (stack.length && grown < maxGrow) {
    const p = stack.pop()!;
    if (out[p]) continue;
    const ii = p * 4;
    if (
      Math.abs(img[ii] - tr) <= tol &&
      Math.abs(img[ii + 1] - tg) <= tol &&
      Math.abs(img[ii + 2] - tb) <= tol
    ) {
      out[p] = 1;
      grown++;
      const x = p % bw;
      const y = (p / bw) | 0;
      if (x > 0 && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1); }
      if (x < bw - 1 && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !visited[p - bw]) { visited[p - bw] = 1; stack.push(p - bw); }
      if (y < bh - 1 && !visited[p + bw]) { visited[p + bw] = 1; stack.push(p + bw); }
    }
  }
  return out;
}

/** 把笔刷路径栅格化为 0/1 种子蒙版（复用 maskBrushWidth 的描边宽度）。 */
function brushSeedMask(
  a: Annotation,
  bw: number,
  bh: number,
  boxX: number,
  boxY: number,
): Uint8Array {
  const mask = new Uint8Array(bw * bh);
  const cv = document.createElement("canvas");
  cv.width = bw;
  cv.height = bh;
  const mctx = cv.getContext("2d");
  if (!mctx) return mask;
  mctx.translate(-boxX, -boxY);
  mctx.strokeStyle = "#000";
  strokeBrushPath(mctx, a.points ?? [], maskBrushWidth(a));
  mctx.fillStyle = "#000";
  mctx.lineWidth = 1;
  const id = mctx.getImageData(0, 0, bw, bh);
  for (let i = 0; i < bw * bh; i++) if (id.data[i * 4 + 3] > 8) mask[i] = 1;
  return mask;
}

/** 在给定 ctx 上描笔刷路径（与 pen 同一套贝塞尔平滑，否则快速拖动会成折线）。 */
function strokeBrushPath(
  ctx: CanvasRenderingContext2D,
  pts: [number, number][],
  width: number,
) {
  // 空路径直接返回（paintThroughBrushMask 已挡过一次，这里是第二道防线：
  // 任何调用方漏判都会在 pts[0][0] 上抛 TypeError，整个标注画布渲染崩掉）。
  if (!pts || pts.length === 0) return;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    // 单点：点一下也要有一个圆点，否则用户以为没反应
    ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
  } else if (pts.length === 2) {
    ctx.lineTo(pts[1][0], pts[1][1]);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  }
  ctx.stroke();
}

/**
 * 遮罩合成：先按**整个包围盒**把效果画好，再用笔刷路径当遮罩裁出可见部分。
 *
 * 为什么不逐笔重算：马赛克的格子必须对齐同一套全局网格。若每笔各算一次，
 * 来回涂的重叠处两套网格会错位，看起来就是“格子在打架”。
 *
 * @param paint 在离屏 ctx 上画效果。坐标系是**图层局部**（原点 = 包围盒左上角），
 *              但本函数**不替你平移**；要用底图局部坐标画就自己 translate。
 *              回调里的变换会被 save/restore 包住（见下），不会泄到合成步。
 */
function paintThroughBrushMask(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  box: { x: number; y: number; w: number; h: number },
  paint: (c: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const pts = a.points;
  if (!pts || pts.length === 0) return;
  const w = Math.max(1, Math.ceil(box.w));
  const h = Math.max(1, Math.ceil(box.h));

  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const lctx = layer.getContext("2d");
  if (!lctx) return;
  // ❌ 必须 save/restore 包住回调：回调里的 translate 会一直生效到下面那句
  // `lctx.drawImage(mask, 0, 0)`——遮罩被跟着平移出图层之外，destination-in
  // 于是把刚画好的效果**整块擦掉**。模糊涂抹用了看不到任何效果就是这个
  // （模糊回调要 translate 回底图坐标取样，而马赛克的 paintMosaic 不 translate——
  // 所以同一份代码里马赛克正常、模糊全没）。
  lctx.save();
  paint(lctx, w, h);
  lctx.restore();

  // 遮罩：同尺寸画布上描笔刷路径，再用 destination-in 只留笔刷覆盖到的像素。
  // 直接在 lctx 上用 clip 不行：canvas 没有“把描边转成路径”的 API，
  // 粗线条无法当 clip 区域用。
  const mask = document.createElement("canvas");
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext("2d");
  if (!mctx) return;
  mctx.translate(-box.x, -box.y);
  mctx.strokeStyle = "#000";
  // ❗ 必须与 maskBox 扩边用的同一个宽度，否则笔刷被自己的包围盒裁一圈
  strokeBrushPath(mctx, pts, maskBrushWidth(a));

  lctx.globalCompositeOperation = "destination-in";
  lctx.drawImage(mask, 0, 0);

  ctx.drawImage(layer, box.x, box.y);
}

/** 标注线宽（物理像素） */
export const LINE_WIDTH = 3;
/**
 * 文字 / 序号的默认字号（**物理像素**）。
 *
 * ❗ 只是旧数据的兼容兼底值。新建文字的 `a.size` 由组件按
 * `CSS 字号 × dpr` 算好传进来，不走这个常量。
 *
 * 为什么：字号是**感知量**，写死物理像素会让 DPI 越高字越小——
 * 18 物理像素在 dpr=1 时是 18px，dpr=2.5 时只有 7.2 CSS 像素，
 * 用户反馈的“文字工具看不到任何东西”就是这个（连提交后画在 canvas 上的也一样小）。
 * 几何量（坐标、选区）用物理像素是对的，字号不是。
 */
export const TEXT_SIZE = 18;

/** 行高系数（与 drawAnnot 文字渲染一致）：文字顶部对齐 a.y，整段高度 = 行数 × 字号 × 1.3。 */
export const TEXT_LINE_HEIGHT = 1.3;
/** 复用的离屏测量 ctx（只在浏览器里建一次）。 */
let _measureCtx: CanvasRenderingContext2D | null = null;

/**
 * 文字标注的真实包围盒（物理像素）。多行按 \n 拆，取最宽行作宽度，行数 × 字号 × 行高作高度。
 * 用于三处，保证"点文字任意位置都能选中/改字"：
 *   ① pointHitAnnot 的 text 分支（命中检测，覆盖旧标注 x2===x 退化）；
 *   ② 提交/编辑文字时把真实宽高写进 x2/y2（选中框、后续命中都准）；
 *   ③ 无障碍兜底：非浏览器环境按字符数估算。
 * 字体串必须与 drawAnnot 文字渲染完全一致，否则量出来的宽和画出来的对不齐。
 */
export function measureTextExtent(
  text: string,
  fontPx: number,
  maxW?: number,
): { w: number; h: number } {
  const fs = fontPx || TEXT_SIZE;
  const lines = wrapLines(text ?? "", fs, maxW);
  const fallback = () => ({
    w: Math.max(1, ...lines.map((l) => l.length * fs * 0.6)),
    h: lines.length * fs * TEXT_LINE_HEIGHT,
  });
  const ctx = measureCtx();
  if (!ctx) return fallback();
  ctx.font = textFont(fs);
  let w = 0;
  for (const ln of lines) w = Math.max(w, ctx.measureText(ln || " ").width);
  return { w: w || fs, h: lines.length * fs * TEXT_LINE_HEIGHT };
}

/** 文字渲染的字体串—— 测量、折行、绘制必须用同一个，否则量出来的和画出来的对不齐。 */
function textFont(fs: number): string {
  return `${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
}

function measureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!_measureCtx) {
    const c = document.createElement("canvas");
    _measureCtx = c.getContext("2d");
  }
  return _measureCtx;
}

/* 去水印结果缓存。
 *
 * 为什么必须有：`removeTiledWatermarkRegion` 是 2D FFT + IFFT（纯 JS），而 drawAnnot
 * 在**每次 redraw** 都会被调 —— 去完水印后再画任何标注，每一次 mousemove 都要
 * 对整块区域重做一遍。平铺模式的 annotation 盖住整个选区（2560×1440 级别），
 * 那是秒级开销——表现就是“点了去水印之后整个界面卡住”。
 *
 * 上限只给 3：每份是 bw×bh×4 字节，全屏一份就 ~14MB。截图窗关闭时整个 webview
 * 被销毁（close_screenshot_window 走 window.close），模块状态随之死亡，不会跨会话泄漏。 */
const _dewarpCache = new Map<string, HTMLCanvasElement>();
const DEWARP_CACHE_MAX = 3;

/** 能在它前面断开的字符：CJK / 假名 / 全角标点 / 谚文都可以逐字断。
 *  ⺀-鿿 已含 CJK 部首 / 假名 / 汉字，另加全角形式与谚文，三段就够了。
 *  ❗ 字符类里不能写全角空格（U+3000）这类不可见字符：eslint 的
 *  no-irregular-whitespace 会直接报错，而且看代码的人根本分辨不出那里是什么。
 *  它本来就在 ⺀-鿿 区间内，单列也多余。 */
const CJK_RE = /[⺀-鿿＀-￯가-힯]/;

/**
 * 按最大宽度折行（贪心）。硬换行 `\n` 先拆，再对每一段做软折行。
 *
 * 为什么需要它：文字标注以前不折行，而最终合成的画布就是选区大小 ——
 * 超出选区右边界的那段字**落字后直接被裁掉**，而输入框里明明是完整的。
 * 这是内容丢失，不是样式问题。微信截图的做法是“碰到截图边界就自动换行”，这里同口径。
 *
 * 断行规则（贪心近似浏览器）：
 *   · CJK：任意两字之间可断——汉字等宽，与浏览器结果完全一致；
 *   · 西文：只在空白处断（不拆单词）；
 *   · 单个 token 本身就超宽：强制逐字断，否则会死循环。
 *
 * ❗ 它与输入框的浏览器原生折行是**两套实现**。纯中文完全一致；中英混排 /
 * 超长英文单词极少数情况下可能差一个断点，表现为“框里两行、图上三行”。
 * 这是行数差异而非内容丢失，比裁掉轻得多。
 *
 * @param maxW 最大宽度（与 fontPx 同单位）。不传 / 非正数 / 非有限 = 不折行。
 * @param measure 可注入的宽度函数，**仅为单测**：jsdom 的 canvas.getContext("2d")
 *                返回 null，不注入就只能测到“不折行”那条分支，贪心算法本身零覆盖。
 */
export function wrapLines(
  text: string,
  fontPx: number,
  maxW?: number,
  measure?: (s: string) => number,
): string[] {
  const fs = fontPx || TEXT_SIZE;
  const hard = (text ?? "").split("\n");
  if (!maxW || !Number.isFinite(maxW) || maxW <= 0) return hard;
  let wOf = measure;
  if (!wOf) {
    const ctx = measureCtx();
    if (!ctx) return hard; // 非浏览器环境：量不了就不折，不能拍脑袋断
    ctx.font = textFont(fs);
    wOf = (s: string) => ctx.measureText(s).width;
  }

  const out: string[] = [];
  for (const para of hard) {
    if (para === "") {
      out.push(""); // 空行要保留占位，否则行数与输入框对不上
      continue;
    }
    let cur = "";
    // 先切成“可断单元”：CJK 单字成单元，西文连同尾随空格成一个单元
    for (const unit of splitUnits(para)) {
      if (cur === "") {
        cur = unit;
        // 单个单元就超宽（超长英文单词 / URL）：强制逐字拆
        while (wOf(cur) > maxW && cur.length > 1) {
          let cut = cur.length - 1;
          while (cut > 1 && wOf(cur.slice(0, cut)) > maxW) cut--;
          out.push(cur.slice(0, cut));
          cur = cur.slice(cut);
        }
        continue;
      }
      if (wOf(cur + unit) <= maxW) {
        cur += unit;
      } else {
        out.push(cur);
        cur = unit;
      }
    }
    out.push(cur);
  }
  return out;
}

/** 把一段文本切成可断单元：CJK 逐字，西文按空白成词（空格跟在词尾）。 */
function splitUnits(s: string): string[] {
  const units: string[] = [];
  let buf = "";
  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      if (buf) {
        units.push(buf);
        buf = "";
      }
      units.push(ch);
    } else if (ch === " " || ch === "\t") {
      // 空格归到前一个词尾部：折行时行尾的空格不会被推到下一行行首
      buf += ch;
      units.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) units.push(buf);
  return units;
}

/**
 * 取与给定颜色对比的“墨色”（纯函数，带单测）。
 *
 * 用处：文字 / 序号的描边。只靠 fillText 的话，白字压白底、黑字压黑底
 * 一样看不见——而用户选什么颜色时并不知道底图那块是什么色。
 * QQ 的文字标注默认就带描边。
 *
 * 阈值用感知亮度（ITU-R BT.601 的 0.299/0.587/0.114）而不是算术平均：
 * 纯绿 #22c55e 的算术平均偏暗、感知亮度偏亮，后者才符合肉眼判断。
 */
export function contrastInk(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  // 非 #rrggbb（如 rgba(...)）就给默认白描边：标注调色板全是六位十六进制，
  // 这条只是不让意外输入把描边变成 NaN。
  if (!m) return "#ffffff";
  const n = Number.parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 150 ? "#1a1a1a" : "#ffffff";
}

/**
 * 按绘制顺序排标注：**高亮必须先画**（纯函数，带单测）。
 *
 * 高亮用 `globalCompositeOperation = "multiply"`，而 multiply 是与**已经在画布上
 * 的像素**相乘。如果先画了一个红框、再把黄高亮盖上去，红×黄 会把红框
 * 染成橙色——用户只是想高亮一片区域，不是想改标注的颜色。
 *
 * 排序必须**稳定**：同类元素之间的先后关系就是 z 序，不能打乱。
 */
export function inDrawOrder(annots: Annotation[]): Annotation[] {
  const hi: Annotation[] = [];
  const rest: Annotation[] = [];
  for (const a of annots) (a.type === "highlight" ? hi : rest).push(a);
  return [...hi, ...rest];
}

/* ===== 标注绘制（物理坐标，供 annotCanvas 与合成共用） =====
 * baseImg：可选底图（全屏物理像素）；offX/offY：选区在底图中的偏移——
 * 标注元素坐标是"选区本地"，马赛克/模糊要从底图正确位置采样（V5 修复）。
 * baseImg 缺省时（底图还没解码完）马赛克/模糊画占位棋盘，见 drawPendingBlock。 */

/**
 * 底图未就绪时的占位块：中性灰棋盘。
 *
 * ⚠️ 旧实现用 `a.color` 填实心格子 —— 用户选了绿色就画出一片绿格子，
 * 看起来就像"马赛克功能就长这样"，而不是"底图还没到位"（实测反馈）。
 * 用固定灰阶且不受选色影响，一眼能看出是占位而非成品。
 */
function drawPendingBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cell: number,
) {
  const c = Math.max(4, cell);
  for (let cy = y; cy < y + h; cy += c) {
    for (let cx = x; cx < x + w; cx += c) {
      const odd = (Math.floor((cx - x) / c) + Math.floor((cy - y) / c)) % 2 === 0;
      ctx.fillStyle = odd ? "#9AA3AE" : "#7C848F";
      ctx.fillRect(cx, cy, Math.min(c, x + w - cx), Math.min(c, y + h - cy));
    }
  }
}
export function drawAnnot(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  baseImg?: HTMLImageElement | null,
  offX = 0,
  offY = 0,
) {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (a.type) {
    case "rect": {
      const x = Math.min(a.x, a.x2);
      const y = Math.min(a.y, a.y2);
      ctx.strokeRect(x, y, Math.abs(a.x2 - a.x), Math.abs(a.y2 - a.y));
      break;
    }
    case "ellipse": {
      const x = Math.min(a.x, a.x2);
      const y = Math.min(a.y, a.y2);
      const w = Math.abs(a.x2 - a.x);
      const h = Math.abs(a.y2 - a.y);
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const ang = Math.atan2(a.y2 - a.y, a.x2 - a.x);
      const head = 10 + a.width * 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      // 双箭头：两端各一个箭头头（V6.19）
      const drawHead = (x: number, y: number, dir: number) => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - head * Math.cos(ang + dir), y - head * Math.sin(ang + dir));
        ctx.lineTo(x - head * Math.cos(ang - dir), y - head * Math.sin(ang - dir));
        ctx.closePath();
        ctx.fill();
      };
      drawHead(a.x2, a.y2, 0.45);
      if (a.arrowStyle === "double") drawHead(a.x, a.y, 0.45 + Math.PI);
      break;
    }
    case "pen": {
      const pts = a.points;
      if (!pts || pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (pts.length === 2) {
        ctx.lineTo(pts[1][0], pts[1][1]);
      } else {
        // 二次贝塞尔中点插值（绘图工具的通用做法）：以采样点为控制点、
        // 相邻点的中点为端点，得到 C1 连续的平滑曲线。
        // 旧实现直连 lineTo：mousemove 采样率跟不上快速拖动，点一稀就是一段段折线。
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2;
          const my = (pts[i][1] + pts[i + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        // 最后一段直连收尾，否则笔画会停在倒数第二个中点上
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0], last[1]);
      }
      ctx.stroke();
      break;
    }
    case "highlight": {
      // 高亮 = 半透明强调色（source-over + globalAlpha），不是 multiply。
      // 主流截图工具（微信/QQ/Snipaste/PixPin）一致：半透明色膜，底下内容始终可读——
      // 这是「高亮（强调）」与「打码/马赛克/模糊（遮蔽）」的本质区别。
      // multiply 的坑：深色（含色板近黑 #1f2937）会把白底乘深、黑字乘黑，
      // 文字与底色一起消失 → 完全看不见后面内容（用户反馈）。
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.4;
      if (a.shape === "brush" && a.points && a.points.length > 0) {
        // 随轨迹描线（跟手）；笔宽走 maskBrushWidth 与马赛克/模糊一致
        strokeBrushPath(ctx, a.points, maskBrushWidth(a));
      } else {
        const b = maskBox(a);
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      // globalAlpha 由函数级 ctx.restore() 兜底恢复
      break;
    }
    case "mosaic": {
      const box = maskBox(a);
      if (box.w < 1 || box.h < 1) break;
      // 色块默认 8px（12px 在 2.5K 屏上太粗，实测反馈）；档位见 tools.tsx 的 MOSAIC_LEVELS。
      // 下限 5：与 fine 档对齐，滚轮调到最低也是可见的马赛克——旧下限 2px 等于没打码。
      const cell = Math.max(5, Math.round(a.strength ?? 8));
      if (!baseImg) {
        // 底图未就绪：画中性灰占位棋盘，不能用 a.color（否则就是一片用户选色的实心格子）
        drawPendingBlock(ctx, box.x, box.y, box.w, box.h, cell);
        break;
      }

      // ❗ 网格对齐：把包围盒向外扩到**底图坐标系**里的整格边界。
      //
      // 不这么做的后果：每个马赛克标注都以自己的 box.x 为网格原点，
      // 两个相邻/重叠的马赛克格子就错位了——接缝处一眼就能看出两套网格在打架。
      // 涂抹模式下尤其明显：用户天然会来回抹好几下。
      // 对齐到底图坐标后，全图所有马赛克共用同一套网格，抹多少次都是无缝的。
      const ax = Math.floor((offX + box.x) / cell) * cell - offX;
      const ay = Math.floor((offY + box.y) / cell) * cell - offY;
      const aw = Math.ceil((box.x + box.w - ax) / cell) * cell;
      const ah = Math.ceil((box.y + box.h - ay) / cell) * cell;

      /** 在目标 ctx 上画像素化内容；调用前坐标系原点已在 (ax, ay)。 */
      const paintMosaic = (c: CanvasRenderingContext2D) => {
        const cw = Math.max(1, Math.round(aw / cell));
        const ch = Math.max(1, Math.round(ah / cell));
        const tmp = document.createElement("canvas");
        tmp.width = cw;
        tmp.height = ch;
        const tctx = tmp.getContext("2d");
        if (!tctx) return;
        // 缩小时开平滑：每个格子取的是区域均值而不是单个像素，
        // 否则细文字上会出现“采样到空白就变白”的斜斑。
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(baseImg, offX + ax, offY + ay, aw, ah, 0, 0, cw, ch);
        // 放大回去时用 cw*cell（= aw），让每个格子正好 cell 个像素。
        // 旧实现拉伸到 w，格子宽变成 w/cw 这种小数，边界落在半像素上就是锯齿。
        c.imageSmoothingEnabled = false;
        c.drawImage(tmp, 0, 0, cw * cell, ch * cell);
        c.imageSmoothingEnabled = true;
      };

      if (a.shape === "brush") {
        // 离屏层的原点已经就是 (ax, ay)（paintThroughBrushMask 回贴时才加回去），
        // 所以这里不需要任何额外平移。
        paintThroughBrushMask(ctx, a, { x: ax, y: ay, w: aw, h: ah }, paintMosaic);
      } else {
        // rect：扩到整格后要裁回用户拖的矩形，否则会溢出一圈
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.clip();
        ctx.translate(ax, ay);
        paintMosaic(ctx);
        ctx.restore();
      }
      break;
    }
    case "blur": {
      const box = maskBox(a);
      if (box.w < 1 || box.h < 1) break;
      // 默认半径 6（旧值 10 偏糊）；档位见 tools.tsx 的 BLUR_LEVELS
      const radius = Math.max(1, a.strength ?? 6);
      if (!baseImg) {
        // 不用 a.color 画半透明块，否则用户以为“模糊就是一层色膜”
        drawPendingBlock(ctx, box.x, box.y, box.w, box.h, 10);
        break;
      }

      /**
       * 把指定区域的模糊结果画到 c 上（c 的原点对应 (rx, ry)）。
       *
       * ❗ padding 是关键：blur 卷积在临时画布边界处要采样边界**外**的像素，
       * 那里什么都没有 → alpha 被拉低 → 模糊块四周一圈发虚、透出原图。
       * 旧实现的注释说“用不透明临时画布解决了”，那只诊对了现象没诊对原因：
       * 问题不在临时画布内部是不是透明，而在它**外部没有像素**。
       * 现在从底图多取 radius×2 的边距（blurSampleRect 会钉到底图边界内），
       * 模糊完再把边距裁掉。
       */
      const paintBlur = (
        c: CanvasRenderingContext2D,
        rx: number,
        ry: number,
        rw: number,
        rh: number,
      ) => {
        const s = blurSampleRect(
          offX + rx,
          offY + ry,
          rw,
          rh,
          radius,
          baseImg.naturalWidth || baseImg.width,
          baseImg.naturalHeight || baseImg.height,
        );
        const sw = Math.max(1, Math.round(s.sw));
        const sh = Math.max(1, Math.round(s.sh));
        const tmp = document.createElement("canvas");
        tmp.width = sw;
        tmp.height = sh;
        const tctx = tmp.getContext("2d");
        if (!tctx) return;
        tctx.drawImage(baseImg, s.sx, s.sy, s.sw, s.sh, 0, 0, sw, sh);

        const out = document.createElement("canvas");
        out.width = sw;
        out.height = sh;
        const octx = out.getContext("2d");
        if (!octx) return;
        octx.filter = `blur(${radius}px)`;
        octx.drawImage(tmp, 0, 0);
        // 只取中间那块（把 padding 裁掉）。四侧 pad 可能不等（选区贴屏幕边时），
        // 所以偏移要用 blurSampleRect 回的实测值，不能拿 radius*2 当常量用。
        c.drawImage(out, s.padL, s.padT, rw, rh, rx, ry, rw, rh);
      };

      if (a.shape === "brush") {
        paintThroughBrushMask(ctx, a, box, (c) => {
          // 离屏层原点在 box 左上角，所以先把坐标系移回底图局部坐标再画
          c.translate(-box.x, -box.y);
          paintBlur(c, box.x, box.y, box.w, box.h);
        });
      } else {
        paintBlur(ctx, box.x, box.y, box.w, box.h);
      }
      break;
    }
    case "dewarp": {
      // 去水印（路线 A 轻量盲去水印）：盲水印检测 = 局部平滑背景估计 vs 原图差异。
      // 平铺/半透明低密度水印（企业微信/钉钉/飞书）文字占少数像素，文字周围即非水印背景，
      // 可作 inpaint 已知锚点；故先估背景、算 mask（只覆盖水印像素）、再 inpaint 重建。
      // 之前整块 mask.fill(1) 会让 inpaint 无锚点直接卡死（rgba 原样返回 → 看起来没效果）。
      const box = maskBox(a);
      if (box.w < 1 || box.h < 1) break;
      // strength 复用为边缘羽化半径（细/中/粗档 = 6/10/18，见 tools.tsx 的 DEWARP_LEVELS）
      const feather = Math.max(0, a.strength ?? 10);
      if (!baseImg) break; // 底图未就绪（选区确定后必到，这里只是防御）

      const paintDewarp = (c: CanvasRenderingContext2D) => {
        const bw = Math.max(1, Math.ceil(box.w));
        const bh = Math.max(1, Math.ceil(box.h));
        // 结果缓存：同一块区域 + 同一组参数只算一次。
        // key 必须带 offX/offY 与 box：同一个 id 被移动/缩放后取的是底图另一块像素。
        const key = `${a.id}|${offX},${offY}|${box.x},${box.y},${bw},${bh}|${feather}|${a.tiled ? 1 : 0}`;
        const hit = _dewarpCache.get(key);
        if (hit) {
          c.drawImage(hit, 0, 0);
          return;
        }
        const tmp = document.createElement("canvas");
        tmp.width = bw;
        tmp.height = bh;
        const tctx = tmp.getContext("2d");
        if (!tctx) return;
        // 取底图 box 区域（源用底图绝对坐标，不依赖 c 当前变换）
        tctx.drawImage(baseImg, offX + box.x, offY + box.y, bw, bh, 0, 0, bw, bh);
        const id = tctx.getImageData(0, 0, bw, bh);
        if (a.shape === "magic") {
          // 魔棒：从笔刷种子泛洪吸附同色连通区（=整条水印文字），仅对蒙版内 inpaint，
          // 背景零改动。适合斜向/稀疏水印——一笔刷过即选中，免去沿字描边。
          const seeds = brushSeedMask(a, bw, bh, box.x, box.y);
          const mask = magicMaskFromSeeds(
            id.data,
            bw,
            bh,
            seeds,
            MAGIC_WAND_TOL,
            // ❌ 防御上限必须给真实值（旧代码传 bw*bh = 形同虚设）：泛洪一旦把
            // 大片纯色背景当同色吸走，蒙版会盖满整个选区、inpaint 把内容抹掉。
            // 生长超过选区一半即判泄漏停手——水印文字远达不到这个量级，
            // 下限 1024 保证极小选区里魔棒仍可用。
            Math.max(1024, Math.floor((bw * bh) / 2)),
          );
          // 仅蒙版内做扩散 inpaint（周围非蒙版像素是干净背景，作为重建锚点）；
          // 蒙版外像素零改动——半透明水印随蒙版一起被重建掉，无需预减步骤。
          inpaintRegion(id.data, bw, bh, mask, feather);
        } else {
          // 去水印（路线 A' 频域减回）：平铺模式频域提取周期层并逐像素减回
          // （天然处理斜排、不误伤背景、不猜像素）；手动模式频域优先，无周期峰退回框内 inpaint 兜底。
          removeTiledWatermarkRegion(id.data, bw, bh, {
            tiled: !!a.tiled,
            feather,
            radius: 8,
          });
        }
        tctx.putImageData(id, 0, 0);
        if (_dewarpCache.size >= DEWARP_CACHE_MAX) {
          // 丢最早插入的一份（Map 保证插入序）
          const oldest = _dewarpCache.keys().next().value;
          if (oldest !== undefined) _dewarpCache.delete(oldest);
        }
        _dewarpCache.set(key, tmp);
        c.drawImage(tmp, 0, 0);
      };

      if (a.shape === "brush") {
        // 离屏层原点在 box 左上，paintDewarp 直接 (0,0) 落回去即可
        paintThroughBrushMask(ctx, a, box, paintDewarp);
      } else {
        // rect / magic：整块 tmp 直接落回（magic 的选区由 inpaint 蒙版控制，不由笔刷裁切）
        ctx.save();
        ctx.translate(box.x, box.y);
        paintDewarp(ctx);
        ctx.restore();
      }
      break;
    }
    case "text": {
      const fs = a.size ?? TEXT_SIZE;
      ctx.font = `${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      // textBaseline 用 top，直接让文字顶部对齐 a.y —— 与输入框的文字顶部一致。
      // 旧实现是 fillText(text, x, y + size)，把**基线**放在 y+size，比输入框里的
      // 文字低约 0.2em，回车提交的一瞬间文字会往下跳一截。
      // （函数头尾有 save/restore，不用手动恢复 baseline）
      ctx.textBaseline = "top";
      // 先描边再填色（描边在下，不会把字身吃细）。
      // 不加描边的话白字压白底 / 黑字压黑底完全看不见，
      // 而用户选色时并不知道底图那块是什么颜色。
      // 描边宽度跟字号走（约 1/8）：小字用固定宽描边会糊成一团，大字则看不见。
      // miterLimit 压到 2：不然尖角字形（如 W / 又）的接头会拔出长刺。
      const strokeW = Math.max(2, fs / 8);
      ctx.lineWidth = strokeW;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = contrastInk(a.color);
      ctx.fillStyle = a.color;
      // 多行：硬换行拆 + 碰到截图右边界自动换行（微信截图同口径），
      // 逐行叠 TEXT_LINE_HEIGHT（与 measureTextExtent 测量、输入框 line-height 一致）。
      // 空行不画但占位，避免与测量尺寸 / 编辑预览错位（否则回车瞬间整段会跳动）。
      //
      // 折行宽度现算而不存进 Annotation：ctx.canvas.width 就是选区宽（合成画布与标注
      // 画布都是选区尺寸），所以 canvas.width - a.x 就是“从文字起点到截图右边界”。
      // 存字段的话，选区一改存量标注的折行宽就过期了。
      const tlines = wrapLines(a.text ?? "", fs, ctx.canvas.width - a.x);
      const tlineH = fs * TEXT_LINE_HEIGHT;
      tlines.forEach((ln, i) => {
        if (!ln) return;
        const ty = a.y + i * tlineH;
        ctx.strokeText(ln, a.x, ty);
        ctx.fillText(ln, a.x, ty);
      });
      break;
    }
    case "number": {
      const r = (a.size ?? TEXT_SIZE) / 2;
      ctx.beginPath();
      ctx.arc(a.x + r, a.y + r, r, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();
      // 圆圈描边也跟对比墨色：序号选白色时，固定白描边等于没描边，
      // 圆圈在浅底图上就消失了。
      ctx.strokeStyle = contrastInk(a.color);
      // 描边宽也跟字号走：固定 2px 在高 DPI 屏上细到看不见
      ctx.lineWidth = Math.max(2, r / 5);
      ctx.stroke();
      // 圈内数字要与**圈的填色**对比（它就坐在 a.color 上）。
      // 旧实现写死 #fff，选黄色序号时就是白字压黄底，根本读不出数字。
      ctx.fillStyle = contrastInk(a.color);
      ctx.font = `600 ${(a.size ?? TEXT_SIZE) * 0.6}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(a.text ?? "1", a.x + r, a.y + r + 1);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      break;
    }
  }
  ctx.restore();
}
