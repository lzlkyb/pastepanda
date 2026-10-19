/** 预览、关键帧对齐裁剪；原录像保留，后台任务由后端拥有。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import {
  recKeyframes,
  recOpenFile,
  recOpenPreview,
  recReveal,
  type RecKeyframeIndex,
  type RecPreviewData,
} from "@/lib/api/rec";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import { useRecGifExport } from "@/hooks/useRecGifExport";
import { useRecTrimTask } from "@/hooks/useRecTrimTask";
import { TrimFields } from "./RecTrimFields";
import { Timeline } from "./RecTimeline";
import { HelpHint } from "./RecHelpHint";
import { PreviewChrome } from "./RecPreviewChrome";
import { PreviewPlayer } from "./RecPreviewPlayer";
import { PreviewAside } from "./RecPreviewAside";
import { PreviewNotices } from "./RecPreviewNotices";
import { ResizeEdges } from "./RecResizeEdges";
import { useRecPlayback } from "./useRecPlayback";
import { useRecPreviewWindow } from "./useRecPreviewWindow";
import { useRecThumbnails } from "./useRecThumbnails";
import { trimClock } from "./trimClock";
import type { TrimRange } from "./trimSnap";

/**
 * 预览窗（`rec-preview.html` 的根组件）。
 *
 * 2026-10-18「可缩放 + 功能升级」：窗壳从 `resizable(false)` + 单枚 ✕ 改成
 * 可缩放 + 三键 + 最大化态；播放区补逐帧/倍速/音量/循环/全屏；动作行补 GIF 导出；
 * 最大化时右侧出现文件信息与快捷键。窗口能力在 `useRecPreviewWindow`，
 * 播放状态在 `useRecPlayback`，媒体控件在 `PreviewPlayer` —— 本文件只做编排。
 *
 * 2026-10-16 苹果风重做的三条判断仍然有效：一条自绘轨道说明「保留哪一段」、
 * 起止点读数芯片承载键盘与读屏、右下角 `?` 就地解释键位。
 */
export function RecPreview({ data }: { data: RecPreviewData }) {
  const [kf, setKf] = useState<RecKeyframeIndex | null>(null);
  const [kfErr, setKfErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [sel, setSel] = useState<TrimRange | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [closeHint, setCloseHint] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const playback = useRecPlayback();
  // 解构出两个稳定方法：键盘 effect 只跟它们走，别把整个 playback 对象塞进依赖数组
  //（那个对象每次渲染换身份，等于每帧摘挂一次 keydown 监听）
  const { toggle: togglePlay, step: stepFrame } = playback;
  const fail = useCallback((message: string) => setActErr(message), []);
  const win = useRecPreviewWindow(fail);
  const task = useRecTrimTask(data.path);
  // 数组字面量会每次渲染换身份 ⇒ useRecGifExport 的 restore 链会无限重查
  const gifPaths = useMemo(() => [data.path], [data.path]);
  const gif = useRecGifExport(gifPaths);
  const duration = kf?.durationMs || playback.metaMs;
  const fps = kf?.fps ?? null;
  // 必须是稳定字符串：抽帧 hook 拿它当依赖，每渲染换一次身份就会重抽一遍
  const videoSrc = useMemo(() => convertFileSrc(data.path), [data.path]);
  const thumbs = useRecThumbnails(videoSrc, duration);
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
  /** 空格播放/暂停、← → 逐帧。焦点在控件上时不抢键（range 的方向键要留给自己）。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("button,input,select,textarea")) return;
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && fps) {
        event.preventDefault();
        stepFrame(event.key === "ArrowLeft" ? -1 : 1, fps);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fps, stepFrame, togglePlay]);
  useDialogEscape(() => {
    if (task.saving) {
      setCloseHint(true);
      return;
    }
    if (sel || task.saved) {
      setSel(null);
      task.clearSaved();
      setActErr(null);
    } else void win.run("close");
  });
  const run = (action: () => Promise<void>) => {
    setActErr(null);
    void action().catch((e: unknown) => setActErr(e instanceof Error ? e.message : String(e)));
  };
  const range = task.saved ?? sel;
  const error = [task.error, actErr, kfErr, playback.blocked, gif.task?.error, kf?.warning]
    .filter(Boolean)
    .join("；");
  /** 轨道与芯片要的是**具体**区间：没选过就是整段；「没选过」由按钮的 disabled 表达。 */
  const shown: TrimRange = range ?? { inMs: 0, outMs: duration };
  /** 右侧那格只说一件事：保留多久；不能裁的时候说清为什么。 */
  const keepInfo = canTrim
    ? `共 ${trimClock(shown.outMs - shown.inMs)}`
    : kfErr
      ? "无法读取裁剪时间轴"
      : kf
        ? "录制太短（无可对齐关键帧）"
        : "正在读取裁剪时间轴…";
  const gifRunning = !!gif.task?.running;
  return (
    <div className="rec-pv-root" data-max={win.maximized || undefined}>
      <PreviewChrome
        name={data.name}
        bytes={data.bytes}
        durationMs={duration}
        resolution={playback.resolution}
        fps={fps}
        maximized={win.maximized}
        closeLabel={task.saving ? "关闭，后台继续保存" : "关闭预览"}
        onOp={(op) => void win.run(op)}
      />
      <div className="rec-pv-body">
        <div className="rec-pv-main">
          <PreviewPlayer src={videoSrc} durationMs={duration} fps={fps} playback={playback} />
          <Timeline
            duration={duration}
            keyframes={kf?.keyframesMs ?? []}
            frames={thumbs.frames}
            range={shown}
            currentMs={playback.currentMs}
            disabled={!canTrim || task.saving || !!task.saved}
            onSeek={playback.seek}
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
          {gifRunning && (
            <div className="rec-pv-progress" role="status">
              <span>正在导出 GIF {gif.task?.percent ?? 0}%</span>
              <progress className="rec-pv-bar" value={gif.task?.percent ?? 0} max={100} aria-label="GIF 导出进度" />
              <button type="button" className="rec-pv-btn" onClick={() => void gif.cancel()}>
                取消导出
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
          {gif.task?.donePath && !gifRunning && (
            <p className="rec-pv-ok" role="status">
              已导出 GIF：{gif.task.donePath.split(/[/\\]/).pop()}
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
                {/* GIF 后端只接受整段（`rec_gif_start` 没有 in/out），文案不能写「导出选区」 */}
                <button
                  type="button"
                  className="rec-pv-btn"
                  disabled={gifRunning || !!gif.starting || !!gif.restoreError}
                  onClick={() => void gif.start(data.path)}
                  title="按整段导出 GIF（12fps，宽 ≤ 480，循环）"
                >
                  导出 GIF
                </button>
                <button type="button" className="rec-pv-btn" onClick={() => run(() => recReveal(data.path))}>
                  <FolderOpen size={13} aria-hidden="true" />
                  打开文件夹
                </button>
              </>
            )}
            <span className="rec-pv-sp" />
            <HelpHint open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} flipBelow={false}>
              <kbd>空格</kbd> 播放 / 暂停 <kbd>← →</kbd> 逐帧 <kbd>Esc</kbd> 重置范围 / 关闭预览
              <br />
              拖轨道两端选保留段，切点自动对齐关键帧；原录像不会被改动。
            </HelpHint>
          </div>
          <PreviewNotices
            videoBlocked={!!playback.blocked}
            keyframesFailed={!!kfErr}
            trimQueryFailed={task.queryFailed}
            gifRestoreFailed={!!gif.restoreError}
            error={error}
            onSystemPlayer={() => run(() => recOpenFile(data.path))}
            onRetryKeyframes={() => setReload((value) => value + 1)}
            onRetryTrim={() => void task.query()}
            onRetryGif={() => void gif.restore()}
          />
        </div>
        {win.maximized && (
          <PreviewAside
            name={data.name}
            bytes={data.bytes}
            durationMs={duration}
            resolution={playback.resolution}
            fps={fps}
            range={shown}
            onReveal={() => run(() => recReveal(data.path))}
            onOpenFile={() => run(() => recOpenFile(data.path))}
          />
        )}
      </div>
      <ResizeEdges onResize={(dir) => void win.resize(dir)} />
    </div>
  );
}
