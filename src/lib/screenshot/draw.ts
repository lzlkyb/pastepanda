/**
 * 标注绘制：把一个 Annotation 画到 2D context 上。
 *
 * 从 ScreenshotOverlay 抽出的关键理由：annotCanvas 的实时预览与最终合成
 * **共用同一份实现**。两边一旦分叉，就会出现「预览看着对、导出的图不对」
 * 这类最难查的问题——所以它必须是一个独立、无组件状态依赖的纯绘制函数。
 */

import { blurSampleRect } from "./blurRect";
import { maskBox, maskBrushWidth } from "./maskGeom";
import type { Annotation } from "./types";

/** 在给定 ctx 上描笔刷路径（与 pen 同一套贝塞尔平滑，否则快速拖动会成折线）。 */
function strokeBrushPath(
  ctx: CanvasRenderingContext2D,
  pts: [number, number][],
  width: number,
) {
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
export function measureTextExtent(text: string, fontPx: number): { w: number; h: number } {
  const fs = fontPx || TEXT_SIZE;
  const lines = (text ?? "").split("\n");
  const fallback = () => ({
    w: Math.max(1, ...lines.map((l) => l.length * fs * 0.6)),
    h: lines.length * fs * TEXT_LINE_HEIGHT,
  });
  if (typeof document === "undefined") return fallback();
  if (!_measureCtx) {
    const c = document.createElement("canvas");
    _measureCtx = c.getContext("2d");
  }
  const ctx = _measureCtx;
  if (!ctx) return fallback();
  ctx.font = `${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  let w = 0;
  for (const ln of lines) w = Math.max(w, ctx.measureText(ln || " ").width);
  return { w: w || fs, h: lines.length * fs * TEXT_LINE_HEIGHT };
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
      // 乘法混合而不是半透明。
      //
      // 旧实现用 globalAlpha = 0.35 盖一层色膜，叠三层就接近不透明色块，
      // 把底下的文字糊死——而用户用荧光笔就是为了让那些文字更醒目。
      // multiply：白底×黄 = 黄，黑字×黄 = 黑字，**文字始终可读**，
      // 且叠加趋于饱和而不是越叠越黑。MDN 对 multiply 的描述就是“模拟透明彩色滤镜”。
      //
      // ❗ 调用方必须保证高亮**先于其他标注**绘制（见 ScreenshotOverlay 的分两轮）：
      // multiply 会和“已经在画布上的东西”相乘，高亮盖到红框上会把红框染成橙色。
      ctx.globalCompositeOperation = "multiply";
      if (a.shape === "brush" && a.points && a.points.length > 0) {
        // 涂抹：直接描粗线即可（不需遮罩合成——高亮是纯色，
        // 没有马赛克那种“网格必须全局对齐”的约束）。
        // 笔宽走 maskBrushWidth（原本这里自己写了个 ×4，而马赛克/模糊用的是裸 a.width
        // —— 同是“涂抹”却三种宽度，用户切工具就发现笔变细了）。
        strokeBrushPath(ctx, a.points, maskBrushWidth(a));
      } else {
        const b = maskBox(a);
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      break;
    }
    case "mosaic": {
      const box = maskBox(a);
      if (box.w < 1 || box.h < 1) break;
      // 色块默认 8px（12px 在 2.5K 屏上太粗，实测反馈）；档位见 tools.tsx 的 MOSAIC_LEVELS。
      // 下限 2：1px “马赛克”等于没马赛克，而滚轮能调到 1。
      const cell = Math.max(2, Math.round(a.strength ?? 8));
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
      // 多行：按 \n 拆，逐行叠 TEXT_LINE_HEIGHT（与 measureTextExtent 测量、输入框 line-height 一致）。
      // 空行不画但占位，避免与测量尺寸 / 编辑预览错位（否则回车瞬间整段会跳动）。
      const tlines = (a.text ?? "").split("\n");
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
