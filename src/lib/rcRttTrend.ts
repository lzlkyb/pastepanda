/**
 * rcRttTrend — 往返延迟采样的环形缓冲（RcHud 面板 60s 趋势线的单一数据源）。
 *
 * 采样不是定时器：pong 驱动的 `rttMs`（EMA）每变一次由 RcHud push 一点，
 * 面板关着也照收（零成本 useEffect），所以点开第一眼就有近 60s 的线。
 * 数据只活 60 秒窗口 + MAX 点封顶，会话结束无需显式清理（陈旧点被窗口滤掉）。
 */
export interface RttSample {
  /** 采样时刻（epoch ms） */
  t: number;
  ms: number;
}

/** 环形缓冲上限：60s 窗口下 pong 节奏（≤1/s）远用不满，纯防御驻留内存。 */
const MAX_SAMPLES = 300;

let buf: RttSample[] = [];

export function pushRttSample(ms: number, t = Date.now()): void {
  if (!(ms > 0)) return;
  const last = buf[buf.length - 1];
  // EMA 值没变（无新 pong）就不重复记点，线不会因 re-render 变粗。
  if (last && last.ms === ms) return;
  buf.push({ t, ms });
  if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
}

/** 取最近 sec 秒的样本（按时间升序）。 */
export function rttTrendWindow(sec: number, now = Date.now()): RttSample[] {
  const cut = now - sec * 1000;
  return buf.filter((s) => s.t >= cut);
}

export function resetRttTrend(): void {
  buf = [];
}
