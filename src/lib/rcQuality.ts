/**
 * rcQuality — 画质档的**唯一**定义处。
 *
 * 🔴 收口之前这个档位表被写了三遍，且互相不一致：
 *    ① `RcQualityBar` 的 `QUALITIES`（带 fps/宽度说明）；
 *    ② `RcAllowPanel` 的 label（「超清（约 2.5K）」「原生（主屏 4K 硬编）」）；
 *    ③ `rcSessionStats.qualityLabel` 的 if 链（HUD 短文案）。
 *    ① 与 ② 的按钮文字对不上（同一个「超清」两处写法不同），
 *    ③ 是第二份实现。现在全部从这里取。
 *
 * 说明性文字（fps / 宽度 / 「约 2.5K」/「主屏 4K 硬编」）统一降为 `tip`
 * （悬停显示），不再挤进按钮文字——这正是设计稿 §4「说明升为 title」那条。
 */
import type { RcQuality } from "@/lib/api/rc";

export interface RcQualityOption {
  key: RcQuality;
  /** 按钮 / 徽章上的短文案 */
  label: string;
  /** 悬停说明 */
  tip: string;
}

/**
 * 五档，顺序 = 界面上的呈现顺序（音质从低到高）。
 * `tip` 里刻意保留了设置页原有的「约 2.5K」「约 4K」口径——
 * 它们不是第二套文案，而是同一档的补充事实。
 */
export const RC_QUALITIES: readonly RcQualityOption[] = [
  { key: "smooth", label: "流畅", tip: "约 6fps · 宽 960 · 适合弱网" },
  { key: "balanced", label: "均衡", tip: "约 5fps · 宽 1280 · 默认档" },
  { key: "sharp", label: "清晰", tip: "约 8fps · 宽 1920 · 适合局域网" },
  { key: "ultra", label: "超清", tip: "约 5fps · 宽 2560（约 2.5K）· JPEG 路径" },
  { key: "uhd", label: "原生", tip: "主屏硬编原生分辨率（约 4K）· 需 GPU · 无硬编时回落超清" },
];

/** 后端默认档。未知档位一律回落到它，不猜、不显示空文案。 */
export const DEFAULT_QUALITY: RcQuality = "balanced";

const LABELS = new Map<string, string>(RC_QUALITIES.map((o) => [o.key, o.label]));
const DEFAULT_LABEL = LABELS.get(DEFAULT_QUALITY) ?? "均衡";

/**
 * 短文案。给宽度受限的位置用（HUD、画面占位提示）。
 * 未知档回落默认档的文案——与后端默认档一致。
 */
export function qualityLabel(q: string): string {
  return LABELS.get(q) ?? DEFAULT_LABEL;
}
