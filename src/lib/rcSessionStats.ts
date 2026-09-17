/** 会话 HUD 用的轻量统计：fps 滑动窗、RTT、画质档文案。 */

export type FitMode = "fit" | "actual" | "fill";

export function qualityLabel(q: string): string {
  if (q === "uhd") return "原生";
  if (q === "ultra") return "超清";
  if (q === "sharp") return "清晰";
  if (q === "smooth") return "流畅";
  return "均衡";
}

export function scopeLabel(s: string): string {
  if (s === "primary") return "主屏";
  if (s.startsWith("monitor:")) {
    const n = Number(s.slice(8));
    return Number.isFinite(n) ? `屏${n + 1}` : "指定屏";
  }
  return "整屏";
}

/**
 * 通知用的完整范围文案（B3）。
 * 与 HUD 用的短文案 `scopeLabel` 分开：HUD 位置窄、要短；给被控端的提示
 * 说的是一次**隐私相关**的变更，必须把「含副屏」这类信息说全。
 */
export function scopeLabelLong(s: string): string {
  if (s === "primary") return "仅主屏";
  if (s.startsWith("monitor:")) {
    const n = Number(s.slice(8));
    return Number.isFinite(n) ? `第 ${n + 1} 台显示器` : "指定显示器";
  }
  return "整个虚拟屏（含副屏）";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function formatWhen(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 固定长度滑动窗，算最近 fps。 */
export class FpsMeter {
  private times: number[] = [];
  push(now = performance.now()) {
    this.times.push(now);
    if (this.times.length > 30) this.times.shift();
  }
  fps(): number {
    if (this.times.length < 2) return 0;
    const span = this.times[this.times.length - 1] - this.times[0];
    if (span <= 0) return 0;
    return Math.round(((this.times.length - 1) / span) * 1000);
  }
  reset() {
    this.times = [];
  }
}
