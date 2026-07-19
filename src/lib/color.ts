/** 统一的颜色中间表示：RGB(A)，r/g/b ∈ [0,255]，a ∈ [0,1] */
export interface ParsedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i;
const HSL_RE = /^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i;

/** 3/4 位 hex 展开为 6/8 位（每个字符重复一次） */
function expandHex(hex: string): string {
  if (hex.length === 3 || hex.length === 4) {
    return hex.split("").map((c) => c + c).join("");
  }
  return hex;
}

function parseHex(text: string): ParsedColor | null {
  const m = HEX_RE.exec(text);
  if (!m) return null;
  const hex = expandHex(m[1].toLowerCase());
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function parseRgb(text: string): ParsedColor | null {
  const m = RGB_RE.exec(text);
  if (!m) return null;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  if (r > 255 || g > 255 || b > 255) return null;
  const a = m[4] !== undefined ? Number(m[4]) : 1;
  return { r, g, b, a };
}

/** HSL (h: 0-360, s/l: 0-100) -> RGB (0-255) */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n: number) => lNorm - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

/** RGB (0-255) -> HSL (h: 0-360, s/l: 0-100) */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
      case gNorm: h = (bNorm - rNorm) / d + 2; break;
      default: h = (rNorm - gNorm) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function parseHsl(text: string): ParsedColor | null {
  const m = HSL_RE.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const s = Number(m[2]);
  const l = Number(m[3]);
  if (h > 360 || s > 100 || l > 100) return null;
  const { r, g, b } = hslToRgb(h, s, l);
  const a = m[4] !== undefined ? Number(m[4]) : 1;
  return { r, g, b, a };
}

/**
 * 检测一段文本是否整体是 Hex/RGB/HSL 颜色值（内部会 trim），
 * 是则返回统一的 RGB(A) 表示，否则返回 null。不识别 CSS 命名颜色。
 */
export function detectColor(text: string): ParsedColor | null {
  const t = text.trim();
  if (!t) return null;
  return parseHex(t) ?? parseRgb(t) ?? parseHsl(t);
}

function toHexByte(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}

export function toHex(c: ParsedColor): string {
  const hex = `#${toHexByte(c.r)}${toHexByte(c.g)}${toHexByte(c.b)}`;
  return c.a < 1 ? `${hex}${toHexByte(Math.round(c.a * 255))}` : hex;
}

export function toRgb(c: ParsedColor): string {
  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export function toHsl(c: ParsedColor): string {
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  return c.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${c.a})` : `hsl(${h}, ${s}%, ${l}%)`;
}
