import styles from "./VideoSurface.module.css";

/**
 * VideoSurface — 视频面（2026-09-30 实装）。
 *
 * 解码路线**复用桌面帧管线，零重写**：帧泵/解码/统计/回退链全部在共享逻辑层
 * `@/hooks/useRcFrames`（rc-frame-ready 唤醒 → rc_drain_frames 全量取帧 →
 * WebCodecs `H264Decoder`（lib/rcH264，探针真机验证过）→ canvas；JPEG
 * createImageBitmap 同路）。本组件只负责「画布 + 诚实状态层」的呈现：
 *
 * - 会话模式（sessionId 给出）：`RcMobileSession` 持泵，statusText 来自
 *   useRcFrames（等待画面 / 接收异常 = 说实话，U3），首帧后隐藏。
 * - 沙盒模式（sandboxSize 给出）：canvas 尺寸由测试图定，无状态层。
 *
 * canvas 尺寸：会话模式**不设** width/height 属性——由解码 sink 按帧分辨率
 * 直写（与桌面 RcScreenCanvas 同机制）；设了反而会在重渲染时和泵打架。
 *
 * 真机判据沿用（2026-09-29 探针，Xiaomi/Chromium 135）：H.264 全档硬解 ✓、
 * HEVC 硬解 ✓、AAC-LC 全配置 ✓、AV1 不支持（与桌面一致，无影响）。
 */
export function VideoSurface({
  canvasRef,
  className,
  statusText,
  showStatus = false,
  sandboxSize,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  className?: string;
  /** 会话模式下来自 useRcFrames 的状态文案（空串 = 已有画面，不渲染）。 */
  statusText?: string;
  showStatus?: boolean;
  /** 沙盒模式：静态测试图的 canvas 尺寸。 */
  sandboxSize?: { w: number; h: number };
}) {
  return (
    <>
      <canvas
        ref={canvasRef}
        className={className}
        width={sandboxSize?.w}
        height={sandboxSize?.h}
      />
      {showStatus && statusText ? (
        <div className={styles.status}>{statusText}</div>
      ) : null}
    </>
  );
}
