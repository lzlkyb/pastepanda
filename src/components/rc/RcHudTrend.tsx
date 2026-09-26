/**
 * RcHudTrend — 「连接详情」面板头部的 60 秒往返延迟趋势线（2026-09-26 对齐稿）。
 *
 * 业界（TeamViewer/RustDesk/AnyDesk）都没有常驻图，本卡刻意只在面板 open 时
 * 才渲染；采样本身在 rcRttTrend（pong 驱动，面板关着也在记，点开即有整窗历史）。
 * 只画一条往返线：四段拆解仍归面板「分段」行——趋势是体感，分段是排障，不混。
 * 纯 SVG polyline、无动画无 rAF；样本 <2 不出现（一条直线不配占一格）。
 */
import { rttTrendWindow } from "@/lib/rcRttTrend";
import styles from "./RemoteComputer.module.css";

const WINDOW_SEC = 60;
const W = 280;
const H = 56;
const PAD_TOP = 10;
const PAD_BOT = 4;

export function RcHudTrend({ rttMs }: { rttMs: number }) {
  const samples = rttTrendWindow(WINDOW_SEC);
  const pts = rttMs > 0 ? [...samples.map((s) => s.ms), rttMs] : samples.map((s) => s.ms);
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const now = Date.now();
  const t0 = samples.length ? samples[0].t : now - WINDOW_SEC * 1000;
  const tSpan = Math.max(1, now - t0);
  const poly = pts
    .map((ms, i) => {
      const t = i < samples.length ? samples[i].t : now;
      const x = ((t - t0) / tSpan) * W;
      const y = H - PAD_BOT - ((ms - min) / span) * (H - PAD_TOP - PAD_BOT);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const cur = pts[pts.length - 1];
  return (
    <div className={styles.hudTrend}>
      <div className={styles.hudTrendHead}>
        <span>往返延迟 · 近 {WINDOW_SEC}s</span>
        <span>
          min {min} / 当前 {cur} / max {max} ms
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.hudTrendSvg} role="img" aria-label={`近 ${WINDOW_SEC} 秒往返延迟趋势，最低 ${min} 最高 ${max} 毫秒`}>
        <polyline points={poly} className={styles.hudTrendLine} />
      </svg>
    </div>
  );
}
