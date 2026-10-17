/** 预览、关键帧对齐裁剪；原录像保留，后台任务由后端拥有。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pause, Play, X } from "lucide-react";
import {
  recKeyframes,
  recOpenFile,
  recOpenPreview,
  recReveal,
  type RecKeyframeIndex,
  type RecPreviewData,
} from "@/lib/api/rec";
import { formatBytes, formatRecordingTime } from "@/lib/utils";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import { useRecTrimTask } from "@/hooks/useRecTrimTask";
import { TrimFields } from "./RecTrimFields";
import { Timeline } from "./RecTimeline";
import { HelpHint } from "./RecHelpHint";
import { trimClock } from "./trimClock";
import type { TrimRange } from "./trimSnap";

/**
 * 预览窗（`rec-preview.html` 的根组件）。
 *
 * 2026-10-16 苹果风重做（方案 §5 / 设计稿 §05）：
 * ① 三条原生滑杆 → 一条自绘轨道：保留段 + 两侧斜纹 + 关键帧刻度 + 播放头共存，
 *    一眼看出「保留哪一段」（拆到 RecTimeline）；
 * ② 起止点做成读数芯片、键盘与读屏交给视觉隐藏的原生 range（拆到 RecTrimFields）；
 * ③ 播放入口从左下角一枚文字按钮改成画面正中 52px 玻璃按钮，播放中**淡出**而不是消失
 *    （鼠标移上去回来），空格仍是加速器；
 * ④ 键位说明从底部一整行 `<kbd>` 收进条右端的 `?`（L4 就地解释）；
 * ⑤ 文案只留事实：`实际保留 0:03.200 – 0:14.900（0:11.700）` → `共 00:11.7`，
 *    `正在另存 · 42%` → `正在另存 42%`（分隔靠间距，不靠 `·`）。
 */
export function RecPreview({ data }: { data: RecPreviewData }) {
  const [kf, setKf] = useState<RecKeyframeIndex | null>(null);
  const [kfErr, setKfErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [sel, setSel] = useState<TrimRange | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [metaDur, setMetaDur] = useState(0);
  const [videoErr, setVideoErr] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [closeHint, setCloseHint] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const task = useRecTrimTask(data.path);
  const duration = kf?.durationMs || metaDur;
  const canTrim = !!kf && kf.keyframesMs.length >= 2;
  useEffect(() => {
    let alive = true;
    setKfErr(null);
    recKeyframes(data.path)
      .then((index) => {
        if (alive) setKf(index);
      })
      .catch((e: unknown) => {
        if (alive) setKfErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [data.path, reload]);
  const seek = useCallback((ms: number) => {
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
    setCurrentMs(ms);
  }, []);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused)
      void video
        .play()
        .catch(() => setVideoErr("应用内预览无法播放此录像，请用系统播放器打开。裁剪只保留文件中已有的视频帧。"));
    else video.pause();
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== " " || (event.target as HTMLElement)?.closest?.("button,input,select,textarea")) return;
      event.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [togglePlay]);
  useDialogEscape(() => {
    if (task.saving) {
      setCloseHint(true);
      return;
    }
    if (sel || task.saved) {
      setSel(null);
      task.clearSaved();
      setActErr(null);
    } else void getCurrentWindow().close();
  });
  const run = (action: () => Promise<void>) => {
    setActErr(null);
    void action().catch((e: unknown) => setActErr(e instanceof Error ? e.message : String(e)));
  };
  const range = task.saved ?? sel;
  const error = [task.error, actErr, kfErr, videoErr, kf?.warning].filter(Boolean).join("；");
  /** 轨道与芯片要的是**具体**区间：没选过就是整段；「没选过」这件事本身由按钮的 disabled 表达。 */
  const shown: TrimRange = range ?? { inMs: 0, outMs: duration };
  /** 右侧那格只说一件事：保留多久；不能裁的时候说清为什么（这也正是那两枚芯片不可用的原因）。 */
  const keepInfo = canTrim
    ? `共 ${trimClock(shown.outMs - shown.inMs)}`
    : kfErr
      ? "无法读取裁剪时间轴"
      : kf
        ? "录制太短（无可对齐关键帧）"
        : "正在读取裁剪时间轴…";
  /** 保存中关闭 = 任务留在后台，这件事必须写在按钮自己身上（hover 一下就知道，而不是点了才知道）。 */
  const closeLabel = task.saving ? "关闭，后台继续保存" : "关闭预览";
  return (
    <div className="rec-pv-root">
      <div className="rec-pv-head" data-tauri-drag-region>
        <span className="rec-pv-title" data-tauri-drag-region>
          {data.name}
          <em>{formatBytes(data.bytes)}</em>
        </span>
        <button
          type="button"
          className="rec-icon-btn"
          onClick={() => void getCurrentWindow().close()}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      {/* 播放态只把大按钮**淡出**（`:hover` / `:focus-visible` 把它带回来），不卸载：
          卸载后画面正中就没有「暂停」这个出口了，而视频本身只有 1px 高的边缘可点。 */}
      <div className="rec-pv-stage" data-playing={playing || undefined}>
        <video
          ref={videoRef}
          className="rec-pv-video"
          src={convertFileSrc(data.path)}
          preload="metadata"
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
          onError={() => setVideoErr("应用内预览无法播放此录像，请用系统播放器打开。裁剪只保留文件中已有的视频帧。")}
          onLoadedMetadata={(event) =>
            setMetaDur(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration * 1000 : 0)
          }
        />
        <span className="rec-pv-badge">
          {formatRecordingTime(currentMs)} / {formatRecordingTime(duration)}
        </span>
        <button
          type="button"
          className="rec-pv-play"
          onClick={togglePlay}
          aria-label={playing ? "暂停" : "播放"}
          title={playing ? "暂停（空格）" : "播放（空格）"}
        >
          {playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
        </button>
      </div>
      <Timeline
        duration={duration}
        keyframes={kf?.keyframesMs ?? []}
        range={shown}
        currentMs={currentMs}
        disabled={!canTrim || task.saving || !!task.saved}
        onSeek={seek}
        onChange={(next) => {
          task.clearSaved();
          setSel(next);
        }}
      />
      <TrimFields
        duration={duration}
        keyframes={kf?.keyframesMs ?? []}
        value={shown}
        disabled={!canTrim || task.saving || !!task.saved}
        keepInfo={keepInfo}
        onChange={(next) => {
          task.clearSaved();
          setSel(next);
        }}
      />
      {task.saving && (
        <div className="rec-pv-progress" role="status">
          <span>正在另存 {task.percent}%</span>
          <progress className="rec-pv-bar" value={task.percent} max={100} aria-label="裁剪保存进度" />
          <button type="button" className="rec-pv-btn" onClick={() => void task.cancel()}>
            取消裁剪
          </button>
        </div>
      )}
      {closeHint && task.saving && (
        <p className="rec-pv-note">Esc 不会取消保存。请点击「取消裁剪」，或关闭窗口让任务在后台继续。</p>
      )}
      {task.saved && (
        <p className="rec-pv-ok" role="status">
          已另存为新文件：{task.saved.path.split(/[/\\]/).pop()}；原录像保留。
        </p>
      )}
      <div className="rec-pv-actions">
        {task.saved ? (
          <>
            <button
              type="button"
              className="rec-pv-btn primary"
              onClick={() => run(() => recOpenPreview(task.saved!.path))}
            >
              预览裁剪文件
            </button>
            <button type="button" className="rec-pv-btn" onClick={() => run(() => recReveal(task.saved!.path))}>
              打开文件夹
            </button>
            <button
              type="button"
              className="rec-pv-btn"
              onClick={() => {
                task.clearSaved();
                setSel(null);
              }}
            >
              继续裁剪原录像
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="rec-pv-btn primary"
              disabled={!sel || !canTrim || task.saving}
              onClick={() => {
                if (sel) void task.save(sel);
              }}
            >
              {task.saving ? "保存中…" : "另存裁剪"}
            </button>
            <button type="button" className="rec-pv-btn" disabled={!sel || task.saving} onClick={() => setSel(null)}>
              重置
            </button>
          </>
        )}
        <span className="rec-pv-sp" />
        {/* 键位说明按需展开：原来底部常驻一整行 <kbd>（§5.1） */}
        <HelpHint open={helpOpen} onToggle={() => setHelpOpen((v) => !v)}>
          <kbd>空格</kbd> 播放 / 暂停 <kbd>Esc</kbd> 重置范围 / 关闭预览
          <br />
          拖轨道两端选保留段，切点自动对齐关键帧；原录像不会被改动。
        </HelpHint>
      </div>
      {videoErr && (
        <div className="rec-pv-errorRow">
          <button type="button" className="rec-pv-btn" onClick={() => run(() => recOpenFile(data.path))}>
            用系统播放器打开
          </button>
        </div>
      )}
      {kfErr && (
        <div className="rec-pv-errorRow">
          <button type="button" className="rec-pv-btn" onClick={() => setReload((value) => value + 1)}>
            重试时间轴
          </button>
        </div>
      )}
      {task.queryFailed && (
        <div className="rec-pv-errorRow">
          <button type="button" className="rec-pv-btn" onClick={() => void task.query()}>
            重新查询裁剪
          </button>
        </div>
      )}
      {error && (
        <div className="rec-pv-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
