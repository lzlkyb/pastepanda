/**
 * lib/toolboxUsage.ts — 工具箱「最近用过 / 常用 pin」本地痕迹。
 *
 * 只存 ToolKey，不存展示文案——名称/图标仍以 toolbox.ts 为唯一数据源，
 * 这里挂了也不会和清单对不上。localStorage 异常时静默降级为空（工具箱本身不依赖痕迹）。
 */

import type { ToolKey } from "@/lib/toolbox";

const RECENT_KEY = "pastepanda_toolbox_recent";
const USAGE_KEY = "pastepanda_toolbox_usage";
/** 最近一行最多 4 个（设计稿 T2） */
const RECENT_MAX = 4;
/** 用满 N 次才标「常用」，避免点一下就钉住 */
const PIN_MIN_COUNT = 3;
/** pin 徽标最多标前 3 个高频 */
const PIN_MAX = 3;

export type UsageMap = Partial<Record<ToolKey, number>>;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额/隐私模式：忽略，痕迹功能降级 */
  }
}

function isToolKey(v: unknown): v is ToolKey {
  return typeof v === "string" && v.length > 0;
}

/** 读最近用过（新→旧，最多 RECENT_MAX）。坏数据直接丢掉。 */
export function loadRecent(): ToolKey[] {
  const arr = readJson<unknown[]>(RECENT_KEY, []);
  if (!Array.isArray(arr)) return [];
  return arr.filter(isToolKey).slice(0, RECENT_MAX);
}

/** 把 key 提到最前并去重截断；返回新数组（不直接改 state）。 */
export function pushRecent(list: ToolKey[], key: ToolKey): ToolKey[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, RECENT_MAX);
}

export function saveRecent(list: ToolKey[]): void {
  writeJson(RECENT_KEY, list);
}

/** 读累计使用次数。 */
export function loadUsage(): UsageMap {
  const raw = readJson<Record<string, unknown>>(USAGE_KEY, {});
  const out: UsageMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isToolKey(k) && typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[k] = Math.floor(v);
    }
  }
  return out;
}

/** 使用 +1，返回新 map；不落盘（由 saveUsage 统一写，避免连点时写多次）。 */
export function bumpUsage(map: UsageMap, key: ToolKey): UsageMap {
  return { ...map, [key]: (map[key] ?? 0) + 1 };
}

export function saveUsage(map: UsageMap): void {
  writeJson(USAGE_KEY, map);
}

/**
 * 高频 pin：次数 ≥ PIN_MIN_COUNT，按次数降序取前 PIN_MAX。
 * 同次数时保持稳定（不依赖 Object 键序的随机性，用 key 字典序兜底）。
 */
export function pinnedKeys(map: UsageMap): ToolKey[] {
  const entries = Object.entries(map) as [ToolKey, number][];
  return entries
    .filter(([, n]) => n >= PIN_MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PIN_MAX)
    .map(([k]) => k);
}
