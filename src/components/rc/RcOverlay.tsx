/**
 * RcOverlay — 被控横幅 + 发起端会话横幅 + 入站确认条 + 配对敲门。挂在 App 层，**任何模式下都可见**（规则 15）。
 * 没人申请且未被控/未发起时返回 null，不占位。
 *
 * ❗ 只看 `rc_enabled`，**不**依赖知识库同步：远程通道是独立的（方案 A）。
 *
 * B2（2026-09-23）：原先 338 行超红线，四条横幅拆为
 * `RcOutboundBanner` / `RcReconnectBanner` / `RcUnoPassBanner` / `RcPairJoins`，
 * 所有动作经 `runRcAction` 收口——失败也有 toast（规则 15.3，主窗没有错误面板）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { useRc } from "@/hooks/useRc";
import { useRcTrustEnable } from "@/hooks/useRcTrustEnable";
import { useRcAdhoc } from "@/hooks/useRcAdhoc";
import { useRcLocalInjectNotice } from "@/hooks/useRcSessionNotices";
import { runRcAction } from "@/lib/rcFeedback";
import { RcControlBanner } from "./RcControlBanner";
import { RcJoinRequests } from "./RcJoinRequests";
import { RcOutboundBanner } from "./RcOutboundBanner";
import { RcReconnectBanner } from "./RcReconnectBanner";
import { RcUnoPassBanner } from "./RcUnoPassBanner";
import { RcPairJoins } from "./RcPairJoins";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice"; // C4：与 RcSection 统一默认设备名来源；显示名收口见 rcDisplayName
import { rcSetAudioLocalMute, rcHostMuteSet } from "@/lib/api/rc";
import { summonMainWindow } from "@/lib/rcWindow";

export function RcOverlay() {
  const { toast } = useToast();
  // 始终轮询：配对敲门可能在未开「允许被远程」时到达；轮询本身受窗口可见性门控
  const rc = useRc(true);
  /** D2：放权动作（含二次确认）——见 useRcTrustEnable 顶部说明。 */
  const enableTrust = useRcTrustEnable(rc, toast);
  /**
   * 一次性协助的「用后即忘」结账点。挂在主窗口的常驻层（本组件即使 `return null`
   * 也仍然挂载，所以任何时候都在跑）——出码那个对话框在会话开始前就关了，
   * 结账必须落在常驻窗口上，否则「用完即忘」只是一句承诺。
   */
  useRcAdhoc(rc);
  const seenPending = useRef(new Set<string>());

  /**
   * 被控中 / 有会话申请 / 有配对敲门 / 我方发起中 / 自动重连中 /
   * 无人值守固定密码开启（Q2 方案 C 的「常驻横幅」，设计稿第三条对策）才渲染
   */
  const session = rc.status?.session ?? null;
  const pending = rc.status?.pending ?? [];
  const joins = rc.status?.joins ?? [];
  // Q6：免确认设备异常断流后的自动重连进度（此时 session 已被收口）
  const reconnecting = rc.status?.reconnecting ?? null;
  // 方案 C：固定密码开启中。哪怕此刻什么都没发生也要摆出来——
  // 「这台机器正对着知道密码的人开着门」这件事不能只有设置页知道。
  const unoPass = rc.status?.uno_pass ?? null;
  const inboundActive = session?.phase === "inbound_active";
  const outboundLive =
    session?.phase === "outbound_active" || session?.phase === "outbound_pending";

  // A2：本机注入失败（UIPI 拦截对方键鼠 / 释放按住键失败）在**被控机器**上发出。
  // 只在 inbound_active 时监听：同一事件在发起端机器上装的是「对端转发」语义，
  // 常驻监听会给控制端用户弹出一条主语错误（「本机」）的提示。
  useRcLocalInjectNotice(toast, inboundActive);

  /**
   * G3：被控者本机静音。status 在会话中是 2s 一拍（IDLE/ACTIVE 周期），纯 status
   * 驱动会让按钮点下去两秒才动——所以本地先落乐观值，status 到达后再校正。
   * 后端已生效，校正值与乐观值一致，不会闪。
   */
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

  /**
   * G3-C：对端远程静音了本机扬声器。同款乐观 + 校正——点「恢复外放」后提示
   * 要立刻收，两秒后才变会让人觉得没点上；失败再把它摆回来。
   */
  const [spkByPeer, setSpkByPeer] = useState(false);
  useEffect(() => {
    setSpkByPeer(rc.status?.spk_muted_by_peer ?? false);
  }, [rc.status?.spk_muted_by_peer]);
  const restoreSpk = useCallback(() => {
    setSpkByPeer(false);
    void rcHostMuteSet(false)
      .then(() => toast("已恢复本机扬声器外放", "success"))
      .catch((e) => {
        setSpkByPeer(true);
        toast(`恢复失败：${e}`, "error");
      });
  }, [toast]);

  // 窗口可能 hide：有新申请时 toast + 拉起窗口，避免 120s 超时前用户毫无感知
  useEffect(() => {
    const pending = rc.status?.pending ?? [];
    for (const p of pending) {
      if (!seenPending.current.has(p.peer)) {
        seenPending.current.add(p.peer);
        toast(
          `「${rcDisplayName(p, fingerprintOf(p.peer))}」申请远程本机（${
            p.capability === "control" ? "可控" : "只看"
          }）`,
          "info",
        );
        // 窗口 hide/失焦时用户看不见 toast：主动拉起（等同系统级提醒）
        void summonMainWindow();
      }
    }
    // 清掉已消失的
    const alive = new Set(pending.map((p) => p.peer));
    for (const id of Array.from(seenPending.current)) {
      if (!alive.has(id)) seenPending.current.delete(id);
    }
  }, [rc.status?.pending, toast]);

  // A2：被控横幅上的「以后不再询问」需要这台设备的免确认当前态，而 `rc_status` 不带
  // trusted（它在 rc_devices 行上）。主窗的 targets 只在少数动作里刷——被控一开始就
  // 补一次列表，拿到就是准的；拿不到按「未开」处理（按钮点了也只是重复置真，无害）。
  const peer = session?.peer;
  // 动作先取出来做依赖：store 动作是稳定引用，但 eslint 认不得 `rc.x` 这种成员表达式，
  // 直接写进依赖数组会一直报缺依赖。
  const refreshTargets = rc.refreshTargets;
  useEffect(() => {
    if (inboundActive) void refreshTargets();
  }, [inboundActive, peer, refreshTargets]);

  if (
    !inboundActive &&
    !outboundLive &&
    pending.length === 0 &&
    joins.length === 0 &&
    !reconnecting &&
    !unoPass
  ) {
    return null;
  }

  const peerTarget = rc.targets.find((t) => t.node_id === peer);
  const peerTrusted = peerTarget?.trusted ?? false;
  const peerDenied = peerTarget?.denied ?? false;

  return (
    <>
      {inboundActive && session && (
        <RcControlBanner
          session={session}
          busy={rc.busy}
          trusted={peerTrusted}
          // 已被禁止远程本机的设备不摆这个入口：deny 优先级高于免确认（后端如此），
          // 开了也不生效。真实状态由设备行的「已禁止控本机」+「解除禁止」表达。
          onTrust={
            peerDenied
              ? undefined
              : // D2：放权前必须先确认（它挨着「立即结束」，误触代价不对称）
                () =>
                  void enableTrust(
                    session.peer,
                    rcDisplayName(session, fingerprintOf(session.peer)),
                  )
          }
          scopeNotice={rc.scopeNotice}
          onDismissScopeNotice={rc.clearScopeNotice}
          streamNotice={rc.streamNotice}
          onDismissStreamNotice={rc.clearStreamNotice}
          audioLocalMute={audioLocalMute}
          onToggleAudioLocalMute={toggleAudioLocalMute}
          spkMutedByPeer={spkByPeer}
          onRestoreSpk={restoreSpk}
          onEnd={() => {
            void runRcAction(
              () => rc.end(),
              { ok: "已结束远程会话", fail: "结束会话失败" },
              toast,
            );
          }}
        />
      )}
      {outboundLive && session && (
        <RcOutboundBanner
          session={session}
          busy={rc.busy}
          onCancel={rc.cancel}
          onEnd={rc.end}
        />
      )}
      {/* Q6：免确认设备异常断流 → 自动重连进度 / 失败提示。会话已被收口，
          不与上面两条横幅同时出现。 */}
      {reconnecting && !outboundLive && (
        <RcReconnectBanner
          reconnecting={reconnecting}
          busy={rc.busy}
          onRetry={rc.request}
        />
      )}
      <RcJoinRequests
        pending={pending}
        busy={rc.busy}
        onApprove={(id) => {
          void runRcAction(
            () => rc.approve(id),
            { ok: "已同意远程协助", fail: "同意失败" },
            toast,
          );
        }}
        onDeny={(id) => {
          void runRcAction(
            () => rc.deny(id),
            { ok: "已拒绝远程申请", fail: "拒绝失败" },
            toast,
          );
        }}
      />
      <RcPairJoins
        joins={joins}
        busy={rc.busy}
        onDenyJoin={rc.denyJoin}
        onApproveJoin={rc.approveJoin}
      />
      {/* Q2 方案 C：无人值守固定密码的**常驻**横幅（止损按钮在条上）。 */}
      {unoPass && !inboundActive && (
        <RcUnoPassBanner unoPass={unoPass} busy={rc.busy} onDisable={rc.unoPassDisable} />
      )}
    </>
  );
}
