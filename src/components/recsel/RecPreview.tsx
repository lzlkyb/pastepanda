/**
 * RecPreview — 录屏预览裁剪窗（四期 1.4；§18 轻预览范式）。
 *
 * 预览即默认播放整段；拖青色起/终点手柄选保留段（切点关键帧对齐 ±1s，无损零转码）；
 * 「保存裁剪」落新文件（原名 + _剪），原文件不动；Esc 两级取消：先重置选区、再按关窗；
 * 空格播放/暂停（与播放器一致，不另造心智）。吸附规则镜像后端 rec/trim.rs（见 trimSnap.ts）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  recKeyframes,
  recReveal,
  recTrim,
  type RecKeyframeIndex,
  type RecPreviewData,
  type RecTrimResult,
} from "@/lib/api/rec";
import { snapTrimRange, type TrimRange } from "./trimSnap";

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时间轴手柄拖拽侧。 */
type Side = "in" | "out";

export function RecPreview({ data }: { data: RecPreviewData }) {
  const [kf, setKf] = useState<RecKeyframeIndex | null>(null);
  const [kfErr, setKfErr] = useState<string | null>(null);
  const [sel, setSel] = useState<TrimRange | null>(null);
  const [draft, setDraft] = useState<TrimRange | null>(null); // 拖动中的未吸附值
  const [dragSide, setDragSide] = useState<Side | null>(null);
  const [aligned, setAligned] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [metaDur, setMetaDur] = useState(0); // <video> 元数据时长（关键帧扫描的兜底）
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<RecTrimResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const duration = kf?.durationMs || metaDur;
  const shown = draft ?? sel;
  const canTrim = !!kf && kf.keyframesMs.length >= 2;
  const pct = (ms: number) => (duration > 0 ? `${Math.min(100, Math.max(0, (ms / duration) * 100))}%` : "0%");

  // 关键帧索引（吸附刻度 + 裁剪可用性）
  useEffect(() => {
    let dead = false;
    setKfErr(null);
    recKeyframes(data.path)
      .then((v) => !dead && setKf(v))
      .catch((e: unknown) => !dead && setKfErr(e instanceof Error ? e.message : String(e)));
    return () => {
      dead = true;
    };
  }, [data.path]);

  // 播放头：rAF 只在播放时跑（规则 8），暂停/卸载即停
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrentMs(v.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 「✓ 已对齐」闪示 1.6s
  useEffect(() => {
    if (!aligned) return;
    const t = setTimeout(() => setAligned(false), 1600);
    return () => clearTimeout(t);
  }, [aligned]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  // 键盘：空格播放/暂停（焦点在按钮上时交给按钮自身，避免双触发）；Esc 两级取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
        e.preventDefault();
        togglePlay();
      } else if (e.key === "Escape") {
        if (sel || saved) {
          setSel(null);
          setSaved(null);
          setErr(null);
        } else {
          void getCurrentWindow().close();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, saved, togglePlay]);

  const trackMs = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const r = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round(ratio * duration);
    },
    [duration],
  );

  const startDrag = (side: Side) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ms = trackMs(e.clientX);
    setSaved(null);
    setDraft(side === "in" ? { inMs: ms, outMs: sel?.outMs ?? duration } : { inMs: sel?.inMs ?? 0, outMs: ms });
    setDragSide(side);
  };

  // 拖动中：手柄跟原始位置；松手：吸附落定（宁多勿少），退化选段=放弃
  useEffect(() => {
    if (!dragSide || !draft) return;
    const side = dragSide;
    const move = (e: PointerEvent) => {
      const ms = trackMs(e.clientX);
      setDraft((d) => (d ? { ...d, [side === "in" ? "inMs" : "outMs"]: ms } : d));
    };
    const up = () => {
      const snapped = snapTrimRange(kf?.keyframesMs ?? [], duration, draft.inMs, draft.outMs);
      setDragSide(null);
      setDraft(null);
      if (snapped.outMs > snapped.inMs) {
        setSel(snapped);
        setAligned(true);
      } else {
        setSel(null);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragSide, draft, kf, duration, trackMs]);

  const save = () => {
    if (!sel || !canTrim || saving) return;
    setSaving(true);
    setErr(null);
    recTrim(data.path, sel.inMs, sel.outMs)
      .then(setSaved)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  const inPct = pct(shown?.inMs ?? 0);
  const outPct = pct(shown?.outMs ?? duration);
  const ticks = kf && kf.keyframesMs.length <= 300 ? kf.keyframesMs : [];

  return (
    <div className="rec-pv-root">
      <div className="rec-pv-head" data-tauri-drag-region>
        <span className="rec-pv-title" data-tauri-drag-region>
          🎬 {data.name}
          <em>{fmtMB(data.bytes)}</em>
        </span>
        <button type="button" className="rec-pv-x" onClick={() => void getCurrentWindow().close()} title="关闭">
          ✕
        </button>
      </div>

      <video
        ref={videoRef}
        className="rec-pv-video"
        src={convertFileSrc(data.path)}
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(e) => setMetaDur(e.currentTarget.duration * 1000)}
      />

      <div className="rec-pv-timerow">
        <span className="rec-pv-time">{fmtTime(currentMs)}</span>
        <div
          ref={trackRef}
          className={`rec-pv-track${sel || shown ? " has-sel" : ""}`}
          onClick={(e) => {
            const v = videoRef.current;
            if (v) v.currentTime = trackMs(e.clientX) / 1000;
          }}
        >
          <span className="rec-pv-base" />
          {ticks.map((k) => (
            <i key={k} className="rec-pv-kf" style={{ left: pct(k) }} />
          ))}
          {shown ? (
            <>
              <span className="rec-pv-cut" style={{ left: 0, width: inPct }} />
              <span className="rec-pv-cut" style={{ left: outPct, right: 0 }} />
              <span className="rec-pv-sel" style={{ left: inPct, width: `calc(${outPct} - ${inPct})` }} />
            </>
          ) : null}
          <span className="rec-pv-playhead" style={{ left: pct(currentMs) }} />
          <button
            type="button"
            className="rec-pv-handle in"
            style={{ left: inPct }}
            onPointerDown={startDrag("in")}
            aria-label="起点手柄"
          />
          <button
            type="button"
            className="rec-pv-handle out"
            style={{ left: outPct }}
            onPointerDown={startDrag("out")}
            aria-label="终点手柄"
          />
          {dragSide && shown ? (
            <span className="rec-pv-bubble" style={{ left: dragSide === "in" ? inPct : outPct }}>
              {fmtTime(dragSide === "in" ? shown.inMs : shown.outMs)}
            </span>
          ) : null}
        </div>
        <span className="rec-pv-time">{fmtTime(duration)}</span>
      </div>

      <div className="rec-pv-actions">
        {saved ? (
          <>
            <span className="rec-pv-ok">✓ 已保存为新文件 {saved.path.split(/[/\\]/).pop()}</span>
            <button type="button" className="rec-pv-btn" onClick={() => recReveal(saved.path).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))}>
              📁 打开文件夹
            </button>
            <button type="button" className="rec-pv-btn primary" onClick={() => void getCurrentWindow().close()}>
              完成
            </button>
          </>
        ) : (
          <>
            <span className="rec-pv-range">
              {sel
                ? `保留 ${fmtTime(sel.inMs)} – ${fmtTime(sel.outMs)}（${Math.round((sel.outMs - sel.inMs) / 1000)}s）${aligned ? " · ✓ 已对齐" : ""}`
                : canTrim
                  ? "拖动手柄选保留段"
                  : "录制太短（无可对齐关键帧），仅可播放"}
            </span>
            <button type="button" className="rec-pv-btn" disabled={!sel} onClick={() => setSel(null)}>
              重置
            </button>
            <button type="button" className="rec-pv-btn primary" disabled={!sel || !canTrim || saving} onClick={save}>
              {saving ? "保存中…" : "✂ 保存裁剪"}
            </button>
          </>
        )}
      </div>

      {err || kfErr ? (
        <div className="rec-pv-err" role="alert">
          {err ?? kfErr}
        </div>
      ) : null}

      <div className="rec-pv-hints">
        <span><kbd>空格</kbd> 播放/暂停</span>
        <span><kbd>Esc</kbd> 重置选区 / 关窗</span>
        <span>切点对齐关键帧（±1s · 无损零转码）</span>
      </div>
    </div>
  );
}
