/**
 * lib/recQuality.ts — 录屏画质档位的**唯一前端数据源**（规则 11）。
 *
 * 与后端 rec/quality.rs 一一对应（original/high/standard/smooth）；
 * 后端 `RecQuality::of_str` 收这里的 key，两处新增档位必须同改。
 * desc 只写「给用户看的差异」，编码参数（fps/编码器）由后端表持有。
 */

export type RecQualityKey = "original" | "high" | "standard" | "smooth";

export interface RecQualityItem {
  key: RecQualityKey;
  label: string;
  desc: string;
}

export const REC_QUALITIES: readonly RecQualityItem[] = [
  { key: "original", label: "原画", desc: "原分辨率 · 60fps · HEVC，画质天花板（体积也最大）" },
  { key: "high", label: "高清", desc: "原分辨率 · 30fps · H.264，兼容性最好" },
  { key: "standard", label: "标准", desc: "1080p · 30fps，均衡" },
  { key: "smooth", label: "流畅", desc: "720p · 30fps，小体积" },
] as const;

export const DEFAULT_REC_QUALITY: RecQualityKey = "high";

export function recQualityOf(key: string | null | undefined): RecQualityItem {
  return (
    REC_QUALITIES.find((q) => q.key === key) ??
    REC_QUALITIES.find((q) => q.key === DEFAULT_REC_QUALITY)!
  );
}
