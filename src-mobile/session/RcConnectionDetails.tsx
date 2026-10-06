import { memo } from "react";
import { Activity, ChevronRight, Monitor } from "lucide-react";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import { qualityHudLabel } from "@/lib/rcQuality";
import { linkStateLabel } from "@/lib/rcSessionStats";
import type { MobileConnectionInfo } from "./useMobileConnectionInfo";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcConnectionDetails.module.css";
const NO_SAMPLE = "暂无样本"; // ui-rule-ok: L3 exception; telemetry is produced by the system, not a user-created list.

export const RcConnectionBadge = memo(function RcConnectionBadge({ info, onOpen }: { info: MobileConnectionInfo; onOpen: () => void }) {
  const tone = info.state === "failed" || info.grade === "poor" ? styles.bad : info.grade === "fair" || info.state === "unstable" || info.state === "reconnecting" ? styles.warn : info.rttMs > 0 ? styles.good : styles.pending;
  return <button type="button" className={`${styles.badge} ${tone}`} onClick={onOpen} aria-label={`连接详情，${info.rttMs > 0 ? `往返延时 ${info.rttMs} 毫秒，` : ""}${info.label}`}>
    <Activity size={15} aria-hidden="true" /><span><small>延时</small>{info.rttMs > 0 ? `${info.rttMs} ms` : info.label}</span><ChevronRight size={12} aria-hidden="true" />
  </button>;
});

function Parameters({ rows }: { rows: [string, string][] }) {
  return <dl className={styles.parameters}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Trend({ info }: { info: MobileConnectionInfo }) {
  const pts = info.samples;
  const min = pts.length ? Math.min(...pts.map(p => p.ms)) : 0;
  const max = pts.length ? Math.max(...pts.map(p => p.ms)) : 0;
  // Fixed time domain: sparse/old samples keep their true position in the last 60 seconds.
  const poly = pts.map(p => `${Math.max(0, Math.min(320, (p.t - info.sampledAt + 60_000) / 60_000 * 320)).toFixed(1)},${(52 - (p.ms - min) / (max - min || 1) * 40).toFixed(1)}`).join(" ");
  return <div className={styles.trend}><div className={styles.trendHead}><span>往返延时 · 近 60 秒</span>{pts.length > 1 && <span>{min}–{max} ms</span>}</div>
    {pts.length > 1 ? <svg viewBox="0 0 320 60" role="img" aria-label={`近 60 秒往返延时，最低 ${min}，最高 ${max} 毫秒`}><polyline points={poly} /></svg> : <p className={ui.hint}>收到更多测量样本后自动显示趋势。</p>}
    <div className={styles.trendHead}><span>60 秒前</span><span>现在</span></div>
  </div>;
}

export const RcConnectionDetails = memo(function RcConnectionDetails({ open, title, info, quality, onClose, onQuality }: {
  open: boolean; title: string; info: MobileConnectionInfo; quality: string; onClose: () => void; onQuality: () => void;
}) {
  const frame = info.frames;
  const number = (n: number | undefined, unit = "ms", approximate = false) => n != null && n > 0 ? `${approximate ? "≈ " : ""}${Math.round(n)} ${unit}` : NO_SAMPLE;
  const codec = frame?.codec === "h264" ? "H.264" : frame?.codec === "hevc" ? "HEVC" : frame?.codec === "av1" ? "AV1" : frame?.codec === "jpeg" ? "JPEG" : NO_SAMPLE;
  const unstable = info.state === "unstable" || info.state === "reconnecting" || info.state === "failed";
  return <MobileSheet open={open} title="连接详情" description={`${title} · 本次会话`} onClose={onClose}>
    <div className={styles.body}>
      {unstable && <MobileNotice tone={info.state === "failed" ? "error" : "warning"}>{info.state === "failed" ? "连接已断开，请返回设备重新连接。" : "连接不稳，正在等待恢复。恢复后继续显示实时读数。"}</MobileNotice>}
      <div className={styles.measurements}>
        <div><span>往返延时</span><strong>{info.rttMs > 0 ? <>{info.rttMs}<small> ms</small></> : "—"}</strong><p>{info.label}</p></div>
        <div><span>实际帧率</span><strong>{frame && frame.fps > 0 ? <>{frame.fps}<small> fps</small></> : "—"}</strong><p>{frame && frame.fps > 0 ? "当前收到的画面帧数" : "等待画面样本"}</p></div>
      </div>
      <Trend info={info} />
      <Parameters rows={[
        ["连接状态", linkStateLabel(info.state)], ["连接方式", info.path || "识别中"],
        ["画面分辨率", frame && frame.size.w > 0 && frame.size.h > 0 ? `${frame.size.w} × ${frame.size.h}` : NO_SAMPLE],
        ["画面编码", codec], ["估计码率", frame && frame.bitrateKbps > 0 ? frame.bitrateKbps >= 1000 ? `${(frame.bitrateKbps / 1000).toFixed(1)} Mbps` : `${Math.round(frame.bitrateKbps)} kbps` : NO_SAMPLE],
        ["画质设置", quality === "unknown" ? "电脑尚未确认" : qualityHudLabel(quality, undefined, true)],
      ]} />
      <details className={styles.advanced}><summary>高级参数<span>延时分段与丢包</span></summary><Parameters rows={[
        ["画面延时（近似）", number(frame?.latencyMs, "ms", true)], ["采集", number(frame?.segCapMs)], ["编码", number(frame?.segEncMs)],
        ["传输（估计）", number(frame?.segNetMs, "ms", true)], ["解码", number(frame?.segDecMs)], ["操作响应（近似）", number(frame?.respMs, "ms", true)],
        ["丢包率", info.lossPermille > 0 ? `${(info.lossPermille / 10).toFixed(1)}%` : NO_SAMPLE],
      ]} /><p className={ui.hint}>往返延时是心跳实测；画面延时是采集到上屏的近似值；操作响应是输入发出到下一帧到达的近似值。静止画面下的帧率不能单独判断连接好坏。</p></details>
      {info.grade === "poor" && <MobileNotice tone="warning">延时偏高。降低画质可能减轻画面负担，但不会直接降低网络往返延时。</MobileNotice>}
      <button type="button" className={ui.secondary} onClick={onQuality}><Monitor size={18} aria-hidden="true" />画面与画质<ChevronRight size={16} aria-hidden="true" /></button>
    </div>
  </MobileSheet>;
});
