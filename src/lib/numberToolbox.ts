/**
 * numberToolbox.ts — 数字工具箱纯逻辑（NumberEditor 用）。
 * 解析文本首个数值，派生 时间戳 / 进制 / 字节 三种解读 + 文本级变换。
 * 纯函数无副作用，便于单元测试。
 */

/** 数值 token：支持千分位逗号、负数、小数（含 ".5" 前导点形式） */
const NUM_TOKEN_RE = /-?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g;

export interface NumberParse {
  /** 解析后的数值（已去逗号） */
  value: number;
  /** 是否整数 */
  isInteger: boolean;
  /** 文本中数值 token 总数（>1 时界面标注"首个"） */
  tokenCount: number;
}

/** 提取文本中的首个数值；无数值返回 null */
export function parseLeadingNumber(text: string): NumberParse | null {
  const matches = text.match(NUM_TOKEN_RE);
  if (!matches || matches.length === 0) return null;
  const value = Number(matches[0].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return { value, isInteger: Number.isInteger(value), tokenCount: matches.length };
}

/** 千分位分组（十进制展示） */
export function formatGrouped(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** 秒级时间戳合理范围：2001-09-09 ~ 2100-01-01 */
const TS_S_MIN = 1_000_000_000;
const TS_S_MAX = 4_102_444_800;

export interface TimestampInfo {
  ms: number;
  unit: "s" | "ms";
  /** 本地时间 YYYY-MM-DD HH:mm:ss */
  local: string;
  /** ISO 8601（UTC，去毫秒） */
  iso: string;
}

/** 时间戳解读：10 位按秒、13 位按毫秒；超范围/非整数返回 null */
export function timestampInfo(n: number): TimestampInfo | null {
  if (!Number.isInteger(n)) return null;
  let ms: number;
  let unit: "s" | "ms";
  if (n >= TS_S_MIN && n <= TS_S_MAX) {
    ms = n * 1000;
    unit = "s";
  } else if (n >= TS_S_MIN * 1000 && n <= TS_S_MAX * 1000) {
    ms = n;
    unit = "ms";
  } else {
    return null;
  }
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { ms, unit, local, iso: d.toISOString().replace(/\.\d+Z$/, "Z") };
}

/** 当前时区偏移标签（如 "UTC+8"） */
export function tzLabel(): string {
  const off = -new Date().getTimezoneOffset() / 60;
  if (off === 0) return "UTC";
  return `UTC${off > 0 ? "+" : ""}${off}`;
}

export interface BaseInfo {
  hex: string;
  oct: string;
  bin: string;
}

/** 进制换算（仅安全整数；负数保留符号前缀） */
export function baseInfo(n: number): BaseInfo | null {
  if (!Number.isSafeInteger(n)) return null;
  const neg = n < 0 ? "-" : "";
  const a = Math.abs(n);
  return {
    hex: `${neg}0x${a.toString(16).toUpperCase()}`,
    oct: `${neg}0o${a.toString(8)}`,
    bin: `${neg}0b${a.toString(2)}`,
  };
}

export interface BytesInfo {
  /** 最佳单位表示，如 "1.66 GB" / "1 KB" */
  best: string;
  /** 次级单位明细（自大到小，最多两项），如 "1,702.25 MB · 1,743,103.13 KB" */
  detail: string;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** 字节单位换算（仅非负整数） */
export function bytesInfo(n: number): BytesInfo | null {
  if (!Number.isInteger(n) || n < 0) return null;
  let u = 0;
  let v = n;
  while (v >= 1024 && u < BYTE_UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const fmt = (x: number) =>
    Number.isInteger(x) ? x.toLocaleString("en-US") : x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const best = `${u === 0 || Number.isInteger(v) ? fmt(v) : v.toFixed(2)} ${BYTE_UNITS[u]}`;
  // 次级明细：最佳单位之下的两级
  const details: string[] = [];
  for (let i = u - 1; i >= 1 && details.length < 2; i--) {
    const dv = n / 1024 ** i;
    if (dv < 1) continue;
    details.push(`${fmt(dv)} ${BYTE_UNITS[i]}`);
  }
  return { best, detail: details.join(" · ") };
}

// ─── 文本级变换（TransformToolbar 用） ─────────────────

/** 千分位：文本内所有数值 token 加分组逗号 */
export function groupNumbersInText(s: string): string {
  return s.replace(NUM_TOKEN_RE, (m) => {
    const n = Number(m.replace(/,/g, ""));
    return Number.isFinite(n) ? formatGrouped(n) : m;
  });
}

/** 去逗号：文本内所有数值 token 剥离分组逗号 */
export function stripNumberCommas(s: string): string {
  return s.replace(NUM_TOKEN_RE, (m) => m.replace(/,/g, ""));
}

/** 取整：文本内所有数值 token 截断为整数 */
export function truncateNumbersInText(s: string): string {
  return s.replace(NUM_TOKEN_RE, (m) => {
    const n = Number(m.replace(/,/g, ""));
    return Number.isFinite(n) ? String(Math.trunc(n)) : m;
  });
}
