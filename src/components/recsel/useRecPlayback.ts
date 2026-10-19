/**
 * 预览窗的媒体播放状态：播放/暂停、逐帧、倍速、音量、循环、全屏读数。
 *
 * 为什么单独成 hook：这些都是**播放器属性**（`playbackRate` / `volume` /
 * `muted` / `loop`）而不是 React 状态，副作用集中在一条 `useEffect` 里压到元素上，
 * UI 组件只剩画控件——否则 `RecPreviewPlayer` 会同时握住元素引用与八份状态。
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** 倍速档位（循环切换）。超过 2× 对「检查一段录屏」没有意义，反而听不清。 */
const RATES = [0.5, 1, 1.5, 2] as const;

const PLAY_FAILED = "应用内预览无法播放此录像，请用系统播放器打开。裁剪只保留文件中已有的视频帧。";

export function useRecPlayback() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [metaMs, setMetaMs] = useState(0);
  const [resolution, setResolution] = useState<string | null>(null);
  const [rate, setRate] = useState<number>(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  /** 播放失败的**人话原因**（容器把它并入错误条，并给出「用系统播放器打开」）。 */
  const [blocked, setBlocked] = useState<string | null>(null);

  const seek = useCallback((ms: number) => {
    const video = videoRef.current;
    const next = Math.max(0, Number.isFinite(ms) ? ms : 0);
    if (video) video.currentTime = next / 1000;
    setCurrentMs(next);
  }, []);
  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setBlocked(PLAY_FAILED));
    else video.pause();
  }, []);
  /**
   * 逐帧：暂停后按 1000/fps 步进。`fps` 为 null（macOS 侧暂未提供）时**不动**，
   * 调用方据同一判据把按钮置灰——拿 1/30 兜底等于把「猜」当成精确。
   */
  const step = useCallback(
    (dir: -1 | 1, fps: number | null) => {
      const video = videoRef.current;
      if (!video || !fps) return;
      video.pause();
      seek(video.currentTime * 1000 + (dir * 1000) / fps);
    },
    [seek],
  );
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    video.volume = volume;
    video.muted = muted;
    video.loop = loop;
  }, [rate, volume, muted, loop]);
  const cycleRate = useCallback(() => {
    setRate((current) => RATES[(RATES.indexOf(current as (typeof RATES)[number]) + 1) % RATES.length] ?? 1);
  }, []);
  const toggleMute = useCallback(() => setMuted((value) => !value), []);
  const toggleLoop = useCallback(() => setLoop((value) => !value), []);
  /** 直接展开到 `<video>` 上的事件：元素自己报的时间最准，不再换算一次。 */
  const events = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (event: { currentTarget: HTMLVideoElement }) =>
      setCurrentMs(event.currentTarget.currentTime * 1000),
    onLoadedMetadata: (event: { currentTarget: HTMLVideoElement }) => {
      const video = event.currentTarget;
      setMetaMs(Number.isFinite(video.duration) ? video.duration * 1000 : 0);
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setResolution(`${video.videoWidth}×${video.videoHeight}`);
      }
    },
    onError: () => setBlocked(PLAY_FAILED),
  };
  return {
    videoRef,
    playing,
    currentMs,
    metaMs,
    resolution,
    rate,
    volume,
    muted,
    loop,
    blocked,
    clearBlocked: () => setBlocked(null),
    events,
    seek,
    toggle,
    step,
    cycleRate,
    setVolume,
    toggleMute,
    toggleLoop,
  };
}
