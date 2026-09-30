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
 * - 乙-③ 收回键鼠 / 允许锁定：状态真源在**后端**（收回还会自动归还），所以这里
 *   用「乐观 + 用返回值校正」而不是纯乐观——后端返回改后的值，锁不上就报锁不上。
 * - 丙-③ 暂停画面：同款「乐观 + 返回值校正」。它与收回键鼠是两条正交的路——
 *   这条挡对方的**眼睛**（画面停帧），那条挡对方的**手**（注入被拦），互不牵连。
 * - D2 免确认：放权动作走 useRcTrustEnable 唯一实现（带二次确认）。
 * - 结束：runRcAction 收口，失败也出 toast（规则 15.3）。
 */
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useRcTrustEnable } from "@/hooks/useRcTrustEnable";
import { runRcAction } from "@/lib/rcFeedback";
import {
  rcSetAudioLocalMute,
  rcHostMuteSet,
  rcInputHold,
  rcInputLockGrant,
  rcVideoPauseSet,
} from "@/lib/api/rc";
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

  // 乙-③ 闸 A：被控者暂时收回自己的键鼠。后端返回**改后的状态**（收回还会在
  // 十分钟后自动归还），所以乐观值一定要被返回值校正一次，否则「归还」之后
  // 按钮还停在收回态。失败要出字——这条挡住的是对方的手，静默失败没人知道。
  const [inputHold, setInputHold] = useState(false);
  useEffect(() => {
    setInputHold(rc.status?.input_hold ?? false);
  }, [rc.status?.input_hold]);
  const toggleInputHold = useCallback(() => {
    const next = !inputHold;
    setInputHold(next);
    void rcInputHold(next)
      .then(setInputHold)
      .catch((e) => {
        setInputHold((cur) => (cur === next ? !next : cur));
        toast(`收回键鼠失败：${e}`, "error");
      });
  }, [inputHold, toast]);

  // 乙-③ 闸 B 的**授权位**（勾选「允许对方锁定我的输入」）。它只是允许，不是
  // 已锁——「锁上了」三态以 `input_lock_active`（读对方钩子实际闸位）为准。
  const [lockGranted, setLockGranted] = useState(false);
  useEffect(() => {
    setLockGranted(rc.status?.input_lock_granted ?? false);
  }, [rc.status?.input_lock_granted]);
  const lockActive = rc.status?.input_lock_active ?? false;
  const toggleLockGrant = useCallback(() => {
    const next = !lockGranted;
    setLockGranted(next);
    void rcInputLockGrant(next).catch(() => {
      setLockGranted((cur) => (cur === next ? !next : cur));
    });
  }, [lockGranted]);

  // 丙-③ 画面暂停。同款「乐观 + 用返回值校正」：暂停位只在本场会话成立，会话收口
  // 后端会自己清位，本地留着旧值就成了假状态（下一次被控时按钮还停在「恢复」）。
  const [videoPaused, setVideoPaused] = useState(false);
  useEffect(() => {
    setVideoPaused(rc.status?.video_paused ?? false);
  }, [rc.status?.video_paused]);
  const toggleVideoPause = useCallback(() => {
    const next = !videoPaused;
    setVideoPaused(next);
    void rcVideoPauseSet(next)
      .then(setVideoPaused)
      .catch((e) => {
        setVideoPaused((cur) => (cur === next ? !next : cur));
        // 这条挡的是对方的眼睛，静默失败＝被控者以为屏幕已经挡住了——必须出字。
        toast(`${next ? "暂停" : "恢复"}画面失败：${e}`, "error");
      });
  }, [videoPaused, toast]);

  return {
    audioLocalMute,
    toggleAudioLocalMute,
    spkMutedByPeer,
    restoreSpk,
    inputHold,
    toggleInputHold,
    lockGranted,
    lockActive,
    toggleLockGrant,
    videoPaused,
    toggleVideoPause,
    enableTrust,
    endSession,
  };
}
