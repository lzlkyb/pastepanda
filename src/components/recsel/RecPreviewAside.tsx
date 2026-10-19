/**
 * 预览窗右栏（2026-10-18）：最大化态才出现，只放**增强信息**。
 *
 * 边界：这里不出现任何主操作。窄窗（默认 840）没有这一栏也必须是完整可用的——
 * 另存裁剪、重置、GIF、打开文件夹都在动作行里，这里只是把它们换成「读数 + 入口」。
 */
import { formatBytes, formatRecordingTime } from "@/lib/utils";
import { trimClock } from "./trimClock";
import type { TrimRange } from "./trimSnap";

export function PreviewAside({
  name,
  bytes,
  durationMs,
  resolution,
  fps,
  range,
  onReveal,
  onOpenFile,
}: {
  name: string;
  bytes: number;
  durationMs: number;
  resolution: string | null;
  fps: number | null;
  range: TrimRange;
  onReveal: () => void;
  onOpenFile: () => void;
}) {
  const row = (label: string, value: string, title?: string) => (
    <div className="kv" key={label}>
      <span>{label}</span>
      <b title={title}>{value}</b>
    </div>
  );
  const keys: [string, string][] = [
    ["播放 / 暂停", "空格"],
    ["逐帧", "← →"],
    ["重置范围", "Esc"],
    ["最大化", "双击标题栏"],
  ];
  return (
    <aside className="rec-pv-aside">
      <section className="rec-pv-sec">
        <h4>文件</h4>
        {row("名称", name, name)}
        {row("体积", formatBytes(bytes))}
        {row("时长", formatRecordingTime(durationMs))}
        {row("画面", resolution ?? "—")}
        {row("帧率", fps === null ? "—" : `${Number.isInteger(fps) ? fps : fps.toFixed(1)} fps`)}
        {row("保留段", `${trimClock(range.inMs)} – ${trimClock(range.outMs)}`)}
      </section>
      <section className="rec-pv-sec">
        <h4>快捷键</h4>
        {keys.map(([label, key]) => (
          <div className="kv" key={label}>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </section>
      <section className="rec-pv-sec">
        <h4>打开</h4>
        <button type="button" className="rec-pv-btn" onClick={onReveal}>
          打开所在文件夹
        </button>
        <button type="button" className="rec-pv-btn" onClick={onOpenFile}>
          系统播放器
        </button>
      </section>
    </aside>
  );
}
