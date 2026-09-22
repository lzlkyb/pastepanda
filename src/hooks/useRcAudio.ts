/**
 * useRcAudio — 会话音频接收播放（G3，发起端）。`on` = 用户开关。
 *
 * 40ms 固定轮询 `rc_drain_audio`：音频包小（128kbps ≈ 640B/拍），不占 IPC 配额；
 * 刻意**不**挂进 useRcFrames 的取帧循环——那个有空转退避（静止 1s 后 200ms 一拍），
 * 会让音频饿成断断续续。
 *
 * P2-8：窗口隐藏时整段暂停（与 useRcFrames 同门控）。辅助窗口用 `hide()` 而非
 * `close()`，WebView 一直活着——不门住就是 25 次/秒的隐藏 IPC 空转。恢复可见后
 * 重建 player 继续播（旧游标/解码器在隐藏期已作废，重建比续接干净）。
 */
import { useEffect } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { rcDrainAudio } from "@/lib/api/rc";
import { RcAudioPlayer } from "@/lib/rcAudio";

export function useRcAudio(sessionId: string, on: boolean) {
  const visible = useWindowVisible();
  useEffect(() => {
    if (!on || !visible) return;
    const player = new RcAudioPlayer();
    let alive = true;
    const tick = () => {
      if (!alive) return;
      void rcDrainAudio()
        .then((buf) => {
          if (alive && buf && buf.byteLength > 8) player.consume(buf);
        })
        .catch(() => {
          /* 会话已结束 / 命令不可用：静默，下一拍再试 */
        });
    };
    const timer = window.setInterval(tick, 40);
    // sessionId 进依赖键：会话切换必须整体重建（旧游标/旧解码器全部作废）
    return () => {
      alive = false;
      window.clearInterval(timer);
      player.close();
    };
  }, [sessionId, on, visible]);
}
