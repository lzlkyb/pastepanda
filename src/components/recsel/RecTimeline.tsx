/**
 * RecTimeline — 自绘裁剪时间轴（设计稿 §05：三条原生滑杆 → 一条自绘轨道）。
 *
 * 一条轨道同时说清四件事：**保留哪一段**（keep 亮 / 两侧斜纹 = 会被剪掉）、
 * 播放到哪（playhead）、切点能落在哪（关键帧刻度）、以及正在拖的那一端（气泡读数）。
 * 改前这三件信息被拆在三条原生 `<input type=range>` 里，用户看不出「保留哪一段」，
 * 而原生滑杆的外观与全站的玻璃语言也不搭——这是这一窗廉价感的主要来源。
 *
 * 无障碍：本组件里的手柄与播放头都是**纯鼠标**路径，`aria-hidden` + `tabIndex={-1}`
 * （同一条轨道的键盘与读屏路径由 RecTrimFields 里那两枚视觉隐藏的原生 range 承担，
 * 它俩是真正的 `role="slider"`）。一个控件只报一次，不让读屏听见两个裁剪起点。
 *
 * 🔴 指针坐标 → 时间必须过 `getBoundingClientRect`，宽为 0 时**直接放弃**：
 * jsdom 不做排版（恒 0），除零会得到 NaN 并一路污染 range。
 */
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { snapTrimRange, type TrimRange } from "./trimSnap";
import { trimClock } from "./trimClock";

/** 正在拖的是谁：两端手柄之一，或轨道本身（= 移动播放头，不参与吸附）。 */
type Drag = null | "inMs" | "outMs" | "seek";

export function Timeline({
  duration,
  keyframes,
  range,
  currentMs,
  disabled,
  onChange,
  onSeek,
}: {
  duration: number;
  keyframes: number[];
  /** 已解析的保留段（调用方负责把 null 折成 0 – duration）。 */
  range: TrimRange;
  currentMs: number;
  disabled: boolean;
  onChange: (range: TrimRange) => void;
  onSeek: (ms: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [bubbleMs, setBubbleMs] = useState<number | null>(null);
  const span = Math.max(1, duration);
  const pct = (ms: number) => Math.min(100, Math.max(0, (ms / span) * 100));

  /**
   * 指针 x → 时间。**量不到宽度就返回 null**（不是 0）：jsdom、以及「轨道还没排版」
   * 的那一帧都会走到这里；返回 0 等于宣称「用户拖到了最左边」——对起点手柄来说，
   * 那会把已经选好的保留段当场抹成整片。没有位置就是没有位置，宁可不响应。
   */
  const msAt = (clientX: number): number | null => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box?.width) return null;
    const ms = ((clientX - box.left) / box.width) * duration;
    return Number.isFinite(ms) ? Math.min(duration, Math.max(0, ms)) : null;
  };
  const begin = (kind: Exclude<Drag, null>) => (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    event.preventDefault();
    // 手柄按下不许同时被轨道当成「点空白处移播放头」
    event.stopPropagation();
    setDrag(kind);
    setBubbleMs(kind === "seek" ? currentMs : range[kind]);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag) return;
    const ms = msAt(event.clientX);
    if (ms === null) return;
    if (drag === "seek") {
      // 拖轨道不显示气泡：视频角上的 `当前 / 总长` 读数本来就跟着播放头走，
      // 再飘一个气泡是同一份数据在一屏里说两遍（§5.2）。
      onSeek(ms);
      return;
    }
    const next =
      drag === "inMs"
        ? snapTrimRange(keyframes, duration, ms, range.outMs)
        : snapTrimRange(keyframes, duration, range.inMs, ms);
    setBubbleMs(next[drag]);
    if (next.outMs > next.inMs) onChange(next);
  };
  const end = () => {
    setDrag(null);
    setBubbleMs(null);
  };

  return (
    <div
      ref={trackRef}
      className="rec-pv-track"
      data-disabled={disabled || undefined}
      onPointerDown={begin("seek")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      // ui-rule-ok: 保留段与播放头的 left/width 是运行期按总时长算出来的比例，静态样式表达不了
      style={
        {
          "--pv-in": `${pct(range.inMs)}%`,
          "--pv-keep": `${pct(range.outMs) - pct(range.inMs)}%`,
          "--pv-out": `${pct(range.outMs)}%`,
          "--pv-head": `${pct(currentMs)}%`,
        } as CSSProperties
      }
    >
      <span className="rec-pv-base" />
      <span className="rec-pv-cut before" />
      <span className="rec-pv-keep" />
      <span className="rec-pv-cut after" />
      {keyframes.map((ms) => {
        // ui-rule-ok: 关键帧刻度的 left 是运行期比例，刻度数量也由片长决定
        return <span key={ms} className="rec-pv-kf" style={{ left: `${pct(ms)}%` }} />;
      })}
      <span className="rec-pv-playhead" />
      <button
        type="button"
        className="rec-pv-handle in"
        tabIndex={-1}
        aria-hidden="true"
        title="拖动调整裁剪起点"
        onPointerDown={begin("inMs")}
      >
        {drag === "inMs" && bubbleMs !== null && <span className="rec-pv-bubble">{trimClock(bubbleMs)}</span>}
      </button>
      <button
        type="button"
        className="rec-pv-handle out"
        tabIndex={-1}
        aria-hidden="true"
        title="拖动调整裁剪终点"
        onPointerDown={begin("outMs")}
      >
        {drag === "outMs" && bubbleMs !== null && <span className="rec-pv-bubble">{trimClock(bubbleMs)}</span>}
      </button>
    </div>
  );
}
