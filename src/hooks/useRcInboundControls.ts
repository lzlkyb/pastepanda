/**
 * useRcInboundControls — 被控中「止血动作」的唯一实现（规则 11.1 收口）。
 *
 * 收口的原因：RcControlBanner 在主窗（RcOverlay）与工作台（RcStage inbound 视图）
 * 各挂一份——两个窗口各有自己的 rcStore 实例，静音/外放/免确认/结束这四类动作
 * 若各写各的，乐观更新与确认文案必然漂移。本 hook 只提供状态与动作，横幅的
 * 摆放位置由调用方决定。
 *
 * - G3 静音 / G3-C 外放恢复：乐观更新 + status 到达后校正 + 失败回滚
 *   （详见 RcOverlay 原实现注释，逻辑原样迁入）。
 * - D2 免确认：放权动作走 useRcTrustEnable 唯一实现（带二次确认）。
 * - 结束：runRcAction 收口，失败也出 toast（规则 15.3）。
 */
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useRcTrustEnable } from "@/hooks/useRcTrustEnable";
import { runRcAction } from "@/lib/rcFeedback";
import { rcSetAudioLocalMute, rcHostMuteSet } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";

export function useRcInboundControls(rc: UseRc) {
  const { toast } = useToast();
  const enableTrust = useRcTrustEnable(rc, toast);

  // G3：被控者本机静音。status 会话中 2s 一拍，纯 status 驱动会让按钮慢两拍——
  // 本地先落乐观值，status 到达后校正；后端已生效，校正值与乐观值一致不会闪。
  const [audioLocalMute, setAudioLocalMute] = useState(false);
  useEffect(() => {
    setAudioLocalMute(rc.status?.audio_local_mute ?? false);
  }, [rc.status?.audio_local_mute]);
  const toggleAudioLocalMute = useCallback(() => {
    const next = !audioLocalMute;
    setAudioLocalMute(next);
    // 失败（例如后端拒绝）必须回滚，否则按钮停在一个假状态上。
    // B3：函数式更新 + 先比对——连点两下时先发的失败回滚不得覆盖后一次的乐观值。
    void rcSetAudioLocalMute(next).catch(() =>
      setAudioLocalMute((cur) => (cur === next ? !next : cur)),
    );
  }, [audioLocalMute]);

  // G3-C：对端远程静音了本机扬声器。同款乐观 + 校正——「恢复外放」点了要立刻收。
  const [spkMutedByPeer, setSpkMutedByPeer] = useState(false);
  useEffect(() => {
    setSpkMutedByPeer(rc.status?.spk_muted_by_peer ?? false);
  }, [rc.status?.spk_muted_by_peer]);
  const restoreSpk = useCallback(() => {
    setSpkMutedByPeer(false);
    void rcHostMuteSet(false)
      .then(() => toast("已恢复本机扬声器外放", "success"))
      .catch((e) => {
        setSpkMutedByPeer(true);
        toast(`恢复失败：${e}`, "error");
      });
  }, [toast]);

  const endSession = useCallback(() => {
    void runRcAction(
      () => rc.end(),
      { ok: "已结束远程会话", fail: "结束会话失败" },
      toast,
    );
  }, [rc, toast]);

  return {
    audioLocalMute,
    toggleAudioLocalMute,
    spkMutedByPeer,
    restoreSpk,
    enableTrust,
    endSession,
  };
}
