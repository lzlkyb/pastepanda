/**
 * RecControlBar — 录制中的控制条（rec-control 窗的整个内容）。
 *
 * 结构：拖动抓手 + REC 脉动 + 计时 + 档位只读徽标 + 停止。
 * 「正在写入」态（finalizing）：整条只剩 spinner + 文案，按钮全部撤掉——
 * 收尾期间再点停止只会得到「没有进行中的录制」错误。
 * 拖动走 data-tauri-drag-region（后端已授 start-dragging 权限）。
 */
import { useEffect, useState } from "react";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function RecControlBar({
  qualityLabel,
  onStop,
  finalizing,
}: {
  qualityLabel: string;
  onStop: (discard: boolean) => void;
  finalizing: boolean;
}) {
  const [sec, setSec] = useState(0);
  // 丢弃是「一点即毁且不可恢复」的动作，与停止紧邻——两段确认挡误触：
  // 第一次点进入待确认态（红色实底 + 文案变化），3 秒不点自动回退。
  const [armDiscard, setArmDiscard] = useState(false);
  useEffect(() => {
    if (finalizing) return;
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [finalizing]);
  useEffect(() => {
    if (!armDiscard) return;
    const t = setTimeout(() => setArmDiscard(false), 3000);
    return () => clearTimeout(t);
  }, [armDiscard]);

  if (finalizing) {
    return (
      <div className="rec-ctrl-root" role="status">
        <span className="rec-writing">
          <span className="rec-spinner" />
          正在写入文件…
        </span>
      </div>
    );
  }
  return (
    <div className="rec-ctrl-root">
      <span className="rec-ctrl-grip" data-tauri-drag-region title="拖动">
        ⠿
      </span>
      <span className="rec-recdot" data-tauri-drag-region>
        <i />
        REC
      </span>
      <span className="rec-timer" data-tauri-drag-region>
        {fmt(sec)}
      </span>
      <span className="rec-qual-badge">{qualityLabel}</span>
      <span style={{ flex: 1 }} />
      {armDiscard ? (
        <button
          type="button"
          className="rec-btn-stop"
          onClick={() => onStop(true)}
          title="再点一次确认丢弃，不保存文件"
        >
          确认丢弃？
        </button>
      ) : (
        <button
          type="button"
          className="rec-btn-ghost"
          onClick={() => setArmDiscard(true)}
          title="停止并丢弃，不保存文件"
        >
          丢弃
        </button>
      )}
      <button type="button" className="rec-btn-stop" onClick={() => onStop(false)} title="停止并保存">
        <i />
        停止
      </button>
    </div>
  );
}
