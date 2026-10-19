/**
 * 预览窗标题栏（2026-10-18）：文件身份 + 关键读数 + 三键。
 *
 * 改前只有「文件名 + 一枚 ✕」，用户看不出这段录屏多长/多大/什么分辨率，
 * 也无处最小化、最大化（`resizable(false)` 时期连最大化都做不到）。
 *
 * 双击空白处最大化**不在这里实现**：`data-tauri-drag-region` 自带双击切换，
 * 再挂一个 onDoubleClick 会把同一次双击 toggle 两次（等于没反应）。
 * 状态回填由 `useRecPreviewWindow` 的 DOM resize 对账承担。
 */
import { Copy, Film, Minus, Square, X } from "lucide-react";
import { formatBytes, formatRecordingTime } from "@/lib/utils";
import type { RecPreviewWindowOp } from "@/lib/api/rec";

export function PreviewChrome({
  name,
  bytes,
  durationMs,
  resolution,
  fps,
  maximized,
  closeLabel,
  onOp,
}: {
  name: string;
  bytes: number;
  durationMs: number;
  resolution: string | null;
  fps: number | null;
  maximized: boolean;
  /** 保存中关闭 = 任务留在后台，这句话必须挂在按钮自己身上。 */
  closeLabel: string;
  onOp: (op: RecPreviewWindowOp) => void;
}) {
  return (
    <header className="rec-pv-head" data-tauri-drag-region>
      <span className="rec-pv-mark" aria-hidden="true">
        <Film size={13} />
      </span>
      <span className="rec-pv-title" data-tauri-drag-region title={name}>
        {name}
      </span>
      <span className="rec-pv-meta" data-tauri-drag-region>
        <b>{formatRecordingTime(durationMs)}</b>
        <i aria-hidden="true" />
        <span>{formatBytes(bytes)}</span>
        {resolution && (
          <>
            <i aria-hidden="true" />
            <span>{resolution}</span>
          </>
        )}
        {fps !== null && (
          <>
            <i aria-hidden="true" />
            <span>{Number.isInteger(fps) ? fps : fps.toFixed(1)} fps</span>
          </>
        )}
      </span>
      <span className="rec-pv-grow" data-tauri-drag-region />
      <div className="rec-pv-wins">
        <button
          type="button"
          className="rec-pv-wbtn"
          onClick={() => onOp("minimize")}
          title="最小化"
          aria-label="最小化"
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rec-pv-wbtn"
          onClick={() => onOp("toggle-max")}
          title={maximized ? "向下还原（双击标题栏）" : "最大化（双击标题栏）"}
          aria-label={maximized ? "向下还原" : "最大化"}
        >
          {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="rec-pv-wbtn close"
          onClick={() => onOp("close")}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
