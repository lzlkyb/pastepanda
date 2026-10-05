/**
 * TouchSandbox — 触摸沙盒：无远端会话的手感联调面（设计稿 §6 验证路）。
 *
 * 画一张 1920×1080 测试图充当「远端桌面」，手势层全速运转：判定、反馈、
 * 归一化、rcSendInput 全链路都走——只是没有会话，注入事件被对端语义静默
 * 丢弃（桌面端无会话时 rc_send_input 同样无害失败）。测试图画了坐标刻度，
 * 拿它核对「点哪打哪」的归一化准度。
 */
import { useEffect, useRef } from "react";
import { RcMobileSession } from "../session/RcMobileSession";
import { useSessionClipboard } from "../session/useSessionClipboard";

const W = 1920;
const H = 1080;

function drawTestPattern(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#101a30";
  ctx.fillRect(0, 0, W, H);
  // 棋盘格（与设计稿演示区同款，转屏/缩放时看得出画面朝向）
  const cell = 80;
  ctx.fillStyle = "#0d1526";
  for (let y = 0; y < H / cell; y++) {
    for (let x = 0; x < W / cell; x++) {
      if ((x + y) % 2 === 0) ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  // 坐标刻度十字
  ctx.strokeStyle = "rgba(34, 211, 238, 0.4)";
  ctx.lineWidth = 2;
  ctx.font = "28px monospace";
  ctx.fillStyle = "rgba(154, 168, 189, 0.85)";
  for (const [fx, fy] of [[0.25, 0.25], [0.5, 0.5], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const x = Math.round(W * fx);
    const y = Math.round(H * fy);
    ctx.beginPath();
    ctx.moveTo(x - 30, y);
    ctx.lineTo(x + 30, y);
    ctx.moveTo(x, y - 30);
    ctx.lineTo(x, y + 30);
    ctx.stroke();
    ctx.fillText(`${Math.round(fx * 100)}%,${Math.round(fy * 100)}%`, x + 36, y + 10);
  }
  ctx.fillStyle = "#e6edf7";
  ctx.font = "bold 64px sans-serif";
  ctx.fillText("触摸演示 · 1920 × 1080", 64, 110);
  ctx.font = "32px sans-serif";
  ctx.fillStyle = "rgba(154, 168, 189, 0.9)";
  ctx.fillText("点按=左键 · 长按=右键 · 长按拖=拖拽 · 双指滑动=滚动 · 双指捏合=缩放", 64, 180);
}

export function TouchSandbox({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 沙盒也给真实剪贴板 hook：按钮不再是「点了没反应」，命令失败会在面板里如实报错。
  const clipboard = useSessionClipboard();
  useEffect(() => {
    if (canvasRef.current) drawTestPattern(canvasRef.current);
  }, []);

  return (
    <RcMobileSession
      title="触摸演示"
      subtitle="无远端 · 注入事件被静默丢弃"
      canvasRef={canvasRef}
      contentSize={{ w: W, h: H }}
      clipboard={clipboard}
      onEnd={onExit}
    />
  );
}
