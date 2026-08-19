import { useEffect, useRef, type CSSProperties } from "react";

/**
 * 路线 C 配图：Canvas 实时绘制组件（"全部网页生成"方案）。
 *
 * 设计动机：发版说明/教练卡过去依赖手工截的 jpg（public/shots/*.jpg），
 * 每次发版都要手动截三张图，维护成本高且易 404。改为「用网页 Canvas 按真实
 * 标注渲染逻辑现场画」：
 *   - media 写成插图 key（ocr / mosaic / eraser）时，由本组件现场 Canvas 绘制，
 *     效果是真·像素块/真·擦除/真·模糊，看着像功能真实输出，而非扁平示意；
 *   - media 写成真实图片路径时，仍走 <img>，加载失败自动降级为本组件 default 图。
 * 零图片文件、零手动截图、随主题变色（读取元素 currentColor + 品牌色），永不变形。
 *
 * 绘制逻辑抽成 `paintIllustration`，tools/shot-gen.html 复用同一套代码导出 PNG。
 */

export type IllustrationKind = "ocr" | "mosaic" | "eraser" | "default";

const KNOWN: IllustrationKind[] = ["ocr", "mosaic", "eraser"];

/** 判断 media 是否是插图 key（而非图片路径）。 */
export function isIllustrationKey(media: string | undefined): media is IllustrationKind {
  return !!media && (KNOWN as string[]).includes(media);
}

export function Illustration({
  kind,
  className,
  style,
  title,
}: {
  kind: IllustrationKind;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    // 固定 240×130 逻辑画布，交给 CSS object-fit:cover 适配各种容器比例（不变形、不裁掉关键内容）
    const LW = 240;
    const LH = 130;
    cv.width = Math.round(LW * dpr);
    cv.height = Math.round(LH * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, LW, LH);
    // 主题色：ink 取元素 currentColor（随深/浅主题），accent 取品牌蓝
    const cs = getComputedStyle(cv);
    const ink = cs.color || "#9aa6b8";
    const accent = readAccent(cs) || "#4c8dff";
    try {
      paintIllustration(ctx, kind, LW, LH, { ink, accent });
    } catch {
      /* 绘制异常不阻断弹框 */
    }
  }, [kind]);
  return (
    <canvas
      ref={ref}
      className={className}
      style={style}
      role="img"
      aria-label={title ?? kind}
    />
  );
}

function readAccent(cs: CSSStyleDeclaration): string | null {
  const v = cs.getPropertyValue("--accent").trim();
  return v || null;
}

// ─── 共享绘制逻辑（TS / 纯 JS 同构，供 shot-gen.html 复用） ───────────────

export interface PaintOpts {
  ink?: string;
  accent?: string;
}

export function paintIllustration(
  ctx: CanvasRenderingContext2D,
  kind: IllustrationKind,
  w = 240,
  h = 130,
  opts: PaintOpts = {},
): void {
  const ink = opts.ink ?? "#9aa6b8";
  const accent = opts.accent ?? "#4c8dff";

  // 底：模拟一张被截的图（方便携，让卡片底色透出）
  roundRect(ctx, 10, 10, w - 20, h - 20, 10);
  const g = ctx.createLinearGradient(10, 10, w - 10, h - 10);
  g.addColorStop(0, "rgba(120,135,160,0.10)");
  g.addColorStop(1, "rgba(120,135,160,0.04)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "rgba(150,165,190,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // 伪内容：几条文本行
  withAlpha(ctx, 0.45, () => {
    for (let i = 0; i < 5; i++) {
      roundRect(ctx, 26, 26 + i * 15, i === 4 ? 92 : 150, 7, 3.5);
      ctx.fill();
    }
  });

  if (kind === "ocr") drawOcr(ctx, accent);
  else if (kind === "mosaic") drawMosaic(ctx, accent);
  else if (kind === "eraser") drawEraser(ctx, ink);
  else drawDefault(ctx, ink);
}

function drawOcr(ctx: CanvasRenderingContext2D, accent: string): void {
  // 高亮选区虚线框（包住一段文字）
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 4]);
  roundRect(ctx, 24, 22, 120, 58, 6);
  ctx.fillStyle = hexA(accent, 0.16);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // 右侧「提取结果」面板
  ctx.strokeStyle = "rgba(150,165,190,0.35)";
  ctx.lineWidth = 1;
  roundRect(ctx, 156, 22, 64, 86, 6);
  ctx.stroke();
  ctx.fillStyle = accent;
  roundRect(ctx, 164, 30, 48, 6, 3);
  ctx.fill();
  withAlpha(ctx, 0.6, () => {
    for (let i = 0; i < 5; i++) {
      roundRect(ctx, 164, 44 + i * 11, i === 4 ? 30 : 44, 5, 2.5);
      ctx.fill();
    }
  });
}

function drawMosaic(ctx: CanvasRenderingContext2D, accent: string): void {
  const x0 = 120;
  const y0 = 28;
  const bw = 92;
  const bh = 80;
  const cell = 11;
  // 底层渐变（被像素化的源）
  const g = ctx.createLinearGradient(x0, y0, x0 + bw, y0 + bh);
  g.addColorStop(0, "#6f86c9");
  g.addColorStop(0.5, "#9b7fd0");
  g.addColorStop(1, "#e08aa6");
  ctx.save();
  roundRect(ctx, x0, y0, bw, bh, 6);
  ctx.clip();
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, bw, bh);
  // 像素化：把区域切成平均色块（真·马赛克观感）
  for (let yy = y0; yy < y0 + bh; yy += cell) {
    for (let xx = x0; xx < x0 + bw; xx += cell) {
      const t = (xx - x0) / bw / 2 + (yy - y0) / bh / 2;
      const s = Math.floor(120 + t * 90);
      ctx.fillStyle = `rgba(${s},${s - 18},${s + 34},0.6)`;
      ctx.fillRect(xx, yy, cell - 1, cell - 1);
    }
  }
  ctx.restore();
  // 选区虚线
  ctx.strokeStyle = hexA(accent, 0.6);
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 4]);
  roundRect(ctx, x0, y0, bw, bh, 6);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawEraser(ctx: CanvasRenderingContext2D, ink: string): void {
  const x0 = 120;
  const y0 = 28;
  const bw = 92;
  const bh = 80;
  // 擦除区后的伪内容
  withAlpha(ctx, 0.35, () => {
    for (let i = 0; i < 5; i++) {
      roundRect(ctx, x0 + 8, y0 + 8 + i * 14, bw - 16, 6, 3);
      ctx.fill();
    }
  });
  // 真·擦除：destination-out 把该区域清成透明（透出卡片底色）
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  roundRect(ctx, x0, y0, bw, bh, 6);
  ctx.fill();
  ctx.restore();
  // 擦除区虚线边界 + 橡皮光标
  ctx.strokeStyle = hexA(ink, 0.55);
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 4]);
  roundRect(ctx, x0, y0, bw, bh, 6);
  ctx.stroke();
  ctx.setLineDash([]);
  withAlpha(ctx, 0.85, () => {
    ctx.beginPath();
    ctx.arc(x0 + bw - 16, y0 + bh - 16, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ink 不用（默认图只用 withAlpha 的灰阶），但要与其它 draw* 保持同一签名，故加 _ 前缀
function drawDefault(ctx: CanvasRenderingContext2D, _ink: string): void {
  withAlpha(ctx, 0.4, () => {
    ctx.beginPath();
    ctx.arc(62, 50, 10, 0, Math.PI * 2);
    ctx.fill();
  });
  withAlpha(ctx, 0.25, () => {
    ctx.beginPath();
    ctx.moveTo(28, 100);
    ctx.lineTo(78, 60);
    ctx.lineTo(106, 84);
    ctx.lineTo(138, 54);
    ctx.lineTo(196, 100);
    ctx.closePath();
    ctx.fill();
  });
}

// ── 小工具 ──

function withAlpha(ctx: CanvasRenderingContext2D, a: number, fn: () => void): void {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = a;
  fn();
  ctx.globalAlpha = prev;
}

function hexA(hex: string, a: number): string {
  const m = hex.replace("#", "");
  if (m.length < 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
