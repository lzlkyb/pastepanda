/**
 * 预览窗播放区（2026-10-18）：画面 + 中央播放入口 + 悬浮传输条。
 *
 * 传输条按「检查一段录屏」的实际动作排布，而不是照抄通用播放器：
 * 逐帧 ←/→（帧率读不出时置灰，不拿 1/30 假装精确）、时间读、倍速、音量、
 * 循环、全屏。播放中整条淡到 55%（鼠标移上来或键盘聚焦就回来），
 * 不遮画面也不消失——它同时是「暂停」的唯一出口。
 */
import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Repeat,
  Volume2,
  VolumeX,
} from "lucide-react";
import { formatRecordingTime } from "@/lib/utils";
import { logger } from "@/lib/logger";
import type { useRecPlayback } from "./useRecPlayback";

export function PreviewPlayer({
  src,
  durationMs,
  fps,
  playback,
}: {
  src: string;
  durationMs: number;
  /** null = 文件读不出帧率（macOS 侧暂未提供）⇒ 逐帧两枚按钮不可用。 */
  fps: number | null;
  playback: ReturnType<typeof useRecPlayback>;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const root = document.documentElement;
    if (!root.requestFullscreen) return;
    void root.requestFullscreen().catch((e: unknown) => logger.warn("预览窗全屏切换失败", e));
  };
  const frameHint = fps ? "逐帧（← →）" : "这个文件读不出帧率，无法逐帧";
  const muted = playback.muted || playback.volume === 0;
  return (
    <div className="rec-pv-stage" data-playing={playback.playing || undefined}>
      <video
        ref={playback.videoRef}
        className="rec-pv-video"
        src={src}
        preload="metadata"
        onClick={playback.toggle}
        {...playback.events}
      />
      <button
        type="button"
        className="rec-pv-play"
        onClick={playback.toggle}
        aria-label={playback.playing ? "暂停" : "播放"}
        title={playback.playing ? "暂停（空格）" : "播放（空格）"}
      >
        {playback.playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
      </button>
      <div className="rec-pv-transport" role="toolbar" aria-label="播放控制">
        <button
          type="button"
          className="rec-pv-tb"
          onClick={() => playback.step(-1, fps)}
          disabled={!fps}
          title={frameHint}
          aria-label="上一帧"
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rec-pv-tb"
          onClick={() => playback.step(1, fps)}
          disabled={!fps}
          title={frameHint}
          aria-label="下一帧"
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <span className="rec-pv-time">
          <b>{formatRecordingTime(playback.currentMs)}</b>
          <i aria-hidden="true">/</i>
          <span>{formatRecordingTime(durationMs)}</span>
        </span>
        <span className="rec-pv-grow" />
        <button
          type="button"
          className="rec-pv-tb txt"
          onClick={playback.cycleRate}
          title="播放速度"
          aria-label={`播放速度 ${playback.rate} 倍`}
        >
          {playback.rate}×
        </button>
        <span className="rec-pv-volwrap">
          <button
            type="button"
            className="rec-pv-tb"
            onClick={playback.toggleMute}
            title={muted ? "取消静音" : "静音"}
            aria-label={muted ? "取消静音" : "静音"}
          >
            {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
          </button>
          <input
            className="rec-pv-vol"
            type="range"
            min={0}
            max={100}
            value={Math.round(playback.volume * 100)}
            onChange={(event) => playback.setVolume(Number(event.target.value) / 100)}
            aria-label="音量"
          />
        </span>
        <button
          type="button"
          className="rec-pv-tb"
          onClick={playback.toggleLoop}
          aria-pressed={playback.loop}
          title="循环播放"
          aria-label="循环播放"
        >
          <Repeat size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rec-pv-tb"
          onClick={toggleFullscreen}
          title={fullscreen ? "退出全屏" : "全屏"}
          aria-label={fullscreen ? "退出全屏" : "全屏"}
        >
          {fullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
