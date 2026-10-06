/**
 * RecOverlayParts — 录屏选区覆盖层的**纯展示**部件（规则 7 拆分）：
 * Shades 四块暗遮罩 + ConfirmBar 确认条。不持有状态、不碰 IO——
 * 状态机与鼠标交互都在 RecSelectOverlay。
 */
import { REC_QUALITIES, type RecQualityItem } from "@/lib/recQuality";
import type { Rect } from "./snap";

/** 四块暗遮罩（框外区域；坐标与截图同法）。 */
export function Shades({ rect, screenCss }: { rect: Rect; screenCss: { w: number; h: number } }) {
  const top = { left: 0, top: 0, width: screenCss.w, height: Math.max(0, rect.y) };
  const bottom = {
    left: 0,
    top: rect.y + rect.h,
    width: screenCss.w,
    height: Math.max(0, screenCss.h - rect.y - rect.h),
  };
  const left = { left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h };
  const right = {
    left: rect.x + rect.w,
    top: rect.y,
    width: Math.max(0, screenCss.w - rect.x - rect.w),
    height: rect.h,
  };
  return (
    <>
      {[top, bottom, left, right].map((s, i) => (
        <div
          key={i}
          className="rec-shade"
          style={{ left: s.left, top: s.top, width: s.width, height: s.height }}
        />
      ))}
    </>
  );
}

export function ConfirmBar(props: {
  rect: Rect;
  screenCssW: number;
  screenCssH: number;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
  sysAudio: boolean;
  micAudio: boolean;
  onSys: () => void;
  onMic: () => void;
  onRedraw: () => void;
  onStart: () => void;
}) {
  const { rect, screenCssW, screenCssH, quality, onQuality, sysAudio, micAudio, onSys, onMic, onRedraw, onStart } = props;
  const barW = 520;
  // 水平钳在屏内：选区贴右缘时确认条不能把右半截伸出屏幕（P3，2026-10-05 审查）
  const x = Math.min(
    Math.max(8, rect.x + rect.w / 2 - barW / 2),
    Math.max(8, screenCssW - barW - 8),
  );
  const below = rect.y + rect.h + 14;
  const top = below + 56 > screenCssH ? Math.max(8, rect.y - 70) : below;
  return (
    <div className="rec-glass" style={{ left: x, top, gap: 8 }}>
      <button type="button" className="rec-btn-start" onClick={onStart}>
        <span className="dot" />
        开始录制
      </button>
      <button type="button" className="rec-btn-ghost" onClick={onRedraw}>
        重画
      </button>
      <span className="rec-seg" role="group" aria-label="画质档位">
        {REC_QUALITIES.map((q) => (
          <button
            key={q.key}
            type="button"
            className={quality.key === q.key ? "on" : ""}
            onClick={() => onQuality(q)}
            title={q.desc}
          >
            {q.label}
          </button>
        ))}
      </span>
      <button
        type="button"
        className={`rec-snd${sysAudio ? " on" : " off"}`}
        onClick={onSys}
        title="录进电脑正在播放的声音"
        aria-pressed={sysAudio}
      >
        🔊 系统声音
      </button>
      <button
        type="button"
        className={`rec-snd${micAudio ? " on" : " off"}`}
        onClick={onMic}
        title="录进解说人声"
        aria-pressed={micAudio}
      >
        🎙 麦克风
      </button>
    </div>
  );
}

/** 预览态提示条（底部居中；方案 A 文案 + 「整屏 →」兜底 + 「✕ 退出」鼠标出口）。 */
export function PreviewHintBar({ screenCssH, screenW, screenH, onFullscreen, onCancel }: {
  screenCssH: number; screenW: number; screenH: number; onFullscreen: () => void; onCancel: () => void;
}) {
  return (
    <div
      className="rec-glass"
      style={{ left: "50%", transform: "translateX(-50%)", bottom: screenCssH * 0.08 }}
    >
      <span>
        {screenW}×{screenH}
      </span>
      <span className="muted">|</span>
      <span>悬停选窗口 · 单击录制 · 拖拽自定义</span>
      <button
        type="button"
        className="rec-glass-lnk"
        title="整个画面全录（等价：单击桌面空白处）"
        onClick={onFullscreen}
      >
        整屏 →
      </button>
      <span className="muted">·</span>
      <button
        type="button"
        className="rec-glass-lnk"
        title="关闭选区，什么都不录"
        onClick={onCancel}
      >
        ✕ 退出
      </button>
      <span className="muted">·</span>
      <kbd>Esc</kbd>
    </div>
  );
}

/** 倒计时（只盖选区）；「取消」是鼠标出口（§17：键盘只是加速器）。 */
export function CountdownOverlay({ rect, count, onCancel }: {
  rect: Rect; count: number; onCancel: () => void;
}) {
  return (
    <div
      className="rec-countdown"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <span className="num">{Math.max(1, count)}</span>
      <button type="button" className="rec-glass-lnk" onClick={onCancel}>
        取消
      </button>
      <span className="esc">
        <kbd>Esc</kbd> 回到选区
      </span>
    </div>
  );
}
