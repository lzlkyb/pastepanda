/**
 * useRecStart — 录屏「进倒计时 → 开录」的时序编排（从 RecSelectOverlay 抽出，规则 7）。
 *
 * 三条时序纪律（2026-10-11 乙案实录，守卫 src/__tests__/recCountdownPrewarm.test.tsx）：
 * ① 进倒计时即并行预热硬件编码器：本机「选型 + 开 nvenc」实测 ≈2.8s，3 秒空档正好盖住，
 *    归零时 `rec_start` 才可能秒回；
 * ② 🔴 归零先把本窗清成录制中空态（穿透 + 卸载倒计时）再发起 `rec_start`。顺序反过来，
 *    那 2.8 秒里 DXGI 抓的每一帧都还画着倒计时数字——既卡住进入，又被录进成品开头
 *    （本窗是叠在桌面之上的透明窗，DXGI 抓的是合成后的画面）；
 * ③ 隐身是先付的成本：开录失败必须把交互还回来，否则用户面对一个穿透了的全屏透明窗，
 *    玻璃条上的重试 / 重画 / Esc 全是死路（规则 15.3 不静默）。
 */
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { recPrewarm, recStart, recStop, type RecStartReq } from "@/lib/api/rec";
import { startRecordingWithWatchdog } from "@/lib/recStartGuard";
import type { Phase } from "./useRecSelectMouse";

export function useRecStart({
  phase,
  setPhase,
  countdown,
  setCountdown,
  buildReq,
  setStartErr,
}: {
  phase: Phase;
  setPhase: (p: Phase) => void;
  countdown: number;
  setCountdown: (v: number | ((c: number) => number)) => void;
  /** 开录参数的唯一换算出口（预热与正式开录共用；两处各写一遍就会算出两个键）。 */
  buildReq: () => RecStartReq | null;
  setStartErr: (e: string | null) => void;
}) {
  // 倒计时归零 → 真正开录
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      void beginRecording();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  // 进倒计时 = 目标与档位已定死：预热这一场的编码器
  // 依赖只写 phase：倒计时期间参数不会再变（⋯ 浮层已收起，出口只有取消）
  useEffect(() => {
    if (phase !== "countdown") return;
    const req = buildReq();
    // 预热失败不阻断开录：正式路径自行打开，只是慢一次
    if (req) void recPrewarm(req).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function beginRecording() {
    const req = buildReq();
    if (!req) return;
    const win = getCurrentWindow();
    setPhase("recording");
    try {
      await win.setIgnoreCursorEvents(true);
      // 让「隐身」真正进那一帧：rAF 回调发生时上一帧已合成完毕
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // 超时的 invoke 仍会运行；先请求停止保存，避免留下后台录制。
      await startRecordingWithWatchdog(() => recStart(req), () => recStop(false));
      // 🔴 此后本窗的一切收尾归后端（session::start 的权威收尾）——这里不再有
      // failed 态，异步失败连着本窗销毁一起发生。
    } catch (err) {
      await win.setIgnoreCursorEvents(false).catch(() => {});
      // 留在确认态，玻璃条提示，重试 / 重画 / Esc 都是活路
      setStartErr(err instanceof Error ? err.message : String(err));
      setPhase("confirm");
    }
  }
}
