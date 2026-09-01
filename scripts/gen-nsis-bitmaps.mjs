/**
 * 生成 NSIS 安装向导的品牌位图（.header / .sidebar），并输出预览 PNG 供人工核对。
 *
 * 背景：tauri.conf.json 未配置 headerImage / sidebarImage 时，NSIS 模板会回退到
 * NSIS 自带的默认向导图（win.bmp），安装界面就会显示"默认图标/默认图"。
 * 本脚本用 public/icon.png 合成品牌位图，产物被 tauri.conf.json 引用。
 *
 * 用法：npm run gen:installer-bitmaps
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_LOGO = resolve(ROOT, 'public/icon.png');
const OUT_BMP_DIR = resolve(ROOT, 'src-tauri/icons');
const OUT_PREVIEW_DIR = resolve(ROOT, 'design/installer');

// 品牌渐变（与前端 --version-badge-gradient 一致：#5B6AF0 -> #7C5CF0）
const BRAND_FROM = [0x5b, 0x6a, 0xf0];
const BRAND_TO = [0x7c, 0x5c, 0xf0];

// 样式开关：background 填十六进制色 = 纯色底；不填 = 品牌渐变底。plate 不填 = 不垫圆角牌。
const SPECS = [
  {
    name: 'nsis-header',
    width: 150,
    height: 57,
    background: '#FFFFFF',
    logoSize: 40,
    align: 'center',
  },
  {
    name: 'nsis-sidebar',
    width: 164,
    height: 314,
    background: '#FFFFFF',
    logoSize: 120,
    align: 'center',
  },
];

function loadPng(path) {
  return PNG.sync.read(readFileSync(path));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 双线性采样，返回未预乘的 [r,g,b,a]（0-255） */
function sampleBilinear(img, x, y) {
  const { width, height, data } = img;
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const pick = (px, py) => {
    const i = (py * width + px) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };

  const p00 = pick(x0, y0);
  const p10 = pick(x1, y0);
  const p01 = pick(x0, y1);
  const p11 = pick(x1, y1);

  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) {
    const top = lerp(p00[c], p10[c], fx);
    const bottom = lerp(p01[c], p11[c], fx);
    out[c] = lerp(top, bottom, fy);
  }
  return out;
}

/** 把 logo 等比绘制到画布指定位置（src-over 合成） */
function drawLogo(canvas, logo, size, originX, originY) {
  const { width, height, data } = canvas;
  for (let y = 0; y < size; y += 1) {
    const cy = originY + y;
    if (cy < 0 || cy >= height) continue;
    for (let x = 0; x < size; x += 1) {
      const cx = originX + x;
      if (cx < 0 || cx >= width) continue;
      const sx = ((x + 0.5) * logo.width) / size - 0.5;
      const sy = ((y + 0.5) * logo.height) / size - 0.5;
      const [r, g, b, a] = sampleBilinear(logo, sx, sy);
      const alpha = a / 255;
      if (alpha <= 0) continue;
      const i = (cy * width + cx) * 4;
      data[i] = Math.round(r * alpha + data[i] * (1 - alpha));
      data[i + 1] = Math.round(g * alpha + data[i + 1] * (1 - alpha));
      data[i + 2] = Math.round(b * alpha + data[i + 2] * (1 - alpha));
      data[i + 3] = 255;
    }
  }
}

/** 圆角矩形有向距离场：<0 内部，>0 外部（像素坐标，矩形覆盖 [x0,x1]×[y0,y1]） */
function roundedRectSd(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** 用 SDF 求像素覆盖率（1px 抗锯齿） */
function coverageOf(sd) {
  return Math.min(Math.max(0.5 - sd, 0), 1);
}

function blendPixel(data, i, r, g, b, a) {
  if (a <= 0) return;
  data[i] = Math.round(r * a + data[i] * (1 - a));
  data[i + 1] = Math.round(g * a + data[i + 1] * (1 - a));
  data[i + 2] = Math.round(b * a + data[i + 2] * (1 - a));
}

/** 4× 超采样的半透明圆角牌（白色底 + 亮描边） */
function drawRoundedPlate(canvas, origin, plate) {
  const { size, radius, alpha, borderAlpha, borderWidth } = plate;
  const x0 = origin.x;
  const y0 = origin.y;
  const x1 = origin.x + size;
  const y1 = origin.y + size;
  const innerR = Math.max(radius - borderWidth, 0);
  const samples = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];

  const pxStart = Math.max(Math.floor(x0) - 2, 0);
  const pxEnd = Math.min(Math.ceil(x1) + 2, canvas.width - 1);
  const pyStart = Math.max(Math.floor(y0) - 2, 0);
  const pyEnd = Math.min(Math.ceil(y1) + 2, canvas.height - 1);

  for (let py = pyStart; py <= pyEnd; py += 1) {
    for (let px = pxStart; px <= pxEnd; px += 1) {
      let fill = 0;
      let border = 0;
      for (const [ox, oy] of samples) {
        const sx = px + ox;
        const sy = py + oy;
        const covOuter = coverageOf(roundedRectSd(sx, sy, x0, y0, x1, y1, radius));
        fill += covOuter;
        if (borderWidth > 0) {
          const covInner = coverageOf(
            roundedRectSd(
              sx,
              sy,
              x0 + borderWidth,
              y0 + borderWidth,
              x1 - borderWidth,
              y1 - borderWidth,
              innerR,
            ),
          );
          border += Math.max(0, covOuter - covInner);
        }
      }
      fill /= samples.length;
      border /= samples.length;
      if (fill <= 0 && border <= 0) continue;
      const i = (py * canvas.width + px) * 4;
      blendPixel(canvas.data, i, 255, 255, 255, alpha * fill);
      blendPixel(canvas.data, i, 255, 255, 255, borderAlpha * border);
    }
  }
}

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

function buildCanvas(spec) {
  const { width, height } = spec;
  const solid = spec.background ? hexToRgb(spec.background) : null;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t =
        spec.direction === 'horizontal'
          ? width > 1
            ? x / (width - 1)
            : 0
          : height > 1
            ? y / (height - 1)
            : 0;
      const i = (y * width + x) * 4;
      if (solid) {
        data[i] = solid[0];
        data[i + 1] = solid[1];
        data[i + 2] = solid[2];
      } else {
        data[i] = Math.round(lerp(BRAND_FROM[0], BRAND_TO[0], t));
        data[i + 1] = Math.round(lerp(BRAND_FROM[1], BRAND_TO[1], t));
        data[i + 2] = Math.round(lerp(BRAND_FROM[2], BRAND_TO[2], t));
      }
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** 内容（圆角牌或 logo）在画布上的位置：right = 贴右，center = 居中（默认） */
function contentOrigin(spec, size) {
  if (spec.align === 'right') {
    return {
      x: spec.width - size - (spec.offsetX ?? 0),
      y: Math.round((spec.height - size) / 2),
    };
  }
  return {
    x: Math.round((spec.width - size) / 2),
    y: Math.round((spec.height - size) / 2) + (spec.offsetY ?? 0),
  };
}

/** 24 位 BMP（BI_RGB，自下而上）编码 */
function encodeBmp(canvas) {
  const { width, height, data } = canvas;
  const rowSize = width * 3;
  const padding = (4 - (rowSize % 4)) % 4;
  const stride = rowSize + padding;
  const imageSize = stride * height;
  const buf = Buffer.alloc(54 + imageSize);

  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + imageSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(imageSize, 34);

  let off = 54;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      buf[off] = data[i + 2];
      buf[off + 1] = data[i + 1];
      buf[off + 2] = data[i];
      off += 3;
    }
    for (let p = 0; p < padding; p += 1) buf[off + p] = 0;
    off += padding;
  }
  return buf;
}

function writePreview(canvas, path) {
  const { width, height, data } = canvas;
  const png = new PNG({ width, height });
  data.copy(png.data);
  writeFileSync(path, PNG.sync.write(png));
}

function main() {
  const logo = loadPng(SOURCE_LOGO);
  mkdirSync(OUT_BMP_DIR, { recursive: true });
  mkdirSync(OUT_PREVIEW_DIR, { recursive: true });

  for (const spec of SPECS) {
    const canvas = buildCanvas(spec);
    const plate = spec.plate;

    let logoAt;
    if (plate) {
      const plateAt = contentOrigin(spec, plate.size);
      drawRoundedPlate(canvas, plateAt, plate);
      const offset = Math.round((plate.size - plate.logoSize) / 2);
      logoAt = { x: plateAt.x + offset, y: plateAt.y + offset };
      drawLogo(canvas, logo, plate.logoSize, logoAt.x, logoAt.y);
    } else {
      logoAt = contentOrigin(spec, spec.logoSize);
      drawLogo(canvas, logo, spec.logoSize, logoAt.x, logoAt.y);
    }

    writeFileSync(resolve(OUT_BMP_DIR, `${spec.name}.bmp`), encodeBmp(canvas));
    writePreview(canvas, resolve(OUT_PREVIEW_DIR, `${spec.name}-preview.png`));
    console.log(
      `[gen-nsis-bitmaps] ${spec.name}.bmp ${spec.width}x${spec.height} ` +
        `(bg ${spec.background ?? 'gradient'}, logo ${plate ? plate.logoSize : spec.logoSize}px @ ${logoAt.x},${logoAt.y}` +
        `${plate ? `, plate ${plate.size}px r${plate.radius}` : ''})`,
    );
  }
}

main();
