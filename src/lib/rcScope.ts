/**
 * rcScope — 画面范围的**唯一**定义处。
 *
 * 🔴 收口之前同一个概念有三套说法，且档位都不一致：
 *    ① `RcQualityBar`：整屏 / 仅主屏 / 逐屏（`monitor:N`）
 *    ② `RcAllowPanel`：整个虚拟屏（含副屏）/ 仅主屏 —— 少了逐屏
 *    ③ `rcSessionStats`：HUD 短文案 + 被控端通知长文案
 *    可选项与文案现在都从本文件出。
 *
 * 短 / 长两套文案是**刻意保留**的，不是重复实现：
 *   - `scopeLabel`     给 HUD，位置窄，要短（「整屏」「屏2」）；
 *   - `scopeLabelLong` 给被控端提示，说的是一次**隐私相关**的变更，
 *                      必须把「含副屏」这类信息说全。
 * 两者共用同一份 `BASE_LABELS` 与同一个序号口径，不会各说各话。
 */
import type { RcCaptureScope, RcMonitorInfo } from "@/lib/api/rc";

export interface RcScopeOption {
  key: RcCaptureScope;
  /** 按钮上的文案 */
  label: string;
  /** 悬停说明 */
  tip: string;
}

/** 两个固定档的三种说法。`virtual` 的 long 必须点明「含副屏」——隐私提示的关键信息。 */
const BASE_LABELS: Record<string, { short: string; long: string; tip: string }> = {
  virtual: { short: "整屏", long: "整个虚拟屏（含副屏）", tip: "整个虚拟屏（含副屏拼接）" },
  primary: { short: "主屏", long: "仅主屏", tip: "只截主显示器" },
};

/** `monitor:N` 的 N；不是 monitor 档、或 N 解析不出数字时返回 null。 */
function monitorIndex(s: string): number | null {
  if (!s.startsWith("monitor:")) return null;
  const n = Number(s.slice(8));
  return Number.isFinite(n) ? n : null;
}

/**
 * 可选项：整屏 / 仅主屏 / 逐屏。
 *
 * `monitors` 为空时只有前两项——会话中（`mode="remote"`）显示器列表必须来自对端，
 * 拿本机列表去列对端的屏是误导，所以那里刻意不传。
 */
export function scopeOptions(monitors: readonly RcMonitorInfo[]): RcScopeOption[] {
  return [
    { key: "virtual", label: BASE_LABELS.virtual.short, tip: BASE_LABELS.virtual.tip },
    { key: "primary", label: "仅主屏", tip: BASE_LABELS.primary.tip },
    ...monitors.map((m) => ({
      key: `monitor:${m.index}` as RcCaptureScope,
      label: m.primary ? `屏${m.index + 1}·主` : `屏${m.index + 1}`,
      tip: `${m.w}×${m.h} @ (${m.x},${m.y})`,
    })),
  ];
}

/**
 * 短文案（HUD、会话通知的标题位）。
 * 未知值按最宽的「整屏」，不猜成更窄的范围。
 */
export function scopeLabel(s: string): string {
  if (s.startsWith("monitor:")) {
    const n = monitorIndex(s);
    return n === null ? "指定屏" : `屏${n + 1}`;
  }
  return BASE_LABELS[s]?.short ?? BASE_LABELS.virtual.short;
}

/**
 * 完整文案（给被控端的通知）。
 * 未知值退回**最宽**范围描述：宁可说多，不可说少。
 */
export function scopeLabelLong(s: string): string {
  if (s.startsWith("monitor:")) {
    const n = monitorIndex(s);
    return n === null ? "指定显示器" : `第 ${n + 1} 台显示器`;
  }
  return BASE_LABELS[s]?.long ?? BASE_LABELS.virtual.long;
}
