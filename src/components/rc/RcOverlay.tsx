/**
 * RcOverlay — 被控横幅 + 发起端会话横幅 + 入站确认条 + 配对敲门。挂在 App 层，**任何模式下都可见**（规则 15）。
 * 没人申请且未被控/未发起时返回 null，不占位。
 *
 * ❗ 只看 `rc_enabled`，**不**依赖知识库同步：远程通道是独立的（方案 A）。
 *
 * ⚠️ 体量红线：本文件 338 行 &gt; 300。按纪律本批未改行为故不拆；下次碰到要改它时
 *    必须先拆子组件（横幅拆分：outbound / reconnect / unoPass / joins 各一块）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { useRc } from "@/hooks/useRc";
import { useRcTrustEnable } from "@/hooks/useRcTrustEnable";
import { useRcAdhoc } from "@/hooks/useRcAdhoc";
import { RcControlBanner } from "./RcControlBanner";
import { RcJoinRequests } from "./RcJoinRequests";
import { fingerprintOf } from "@/lib/fingerprint";
import { DEFAULT_RC_DEVICE_NAME } from "@/lib/rcDevice"; // C4：与 RcSection 统一默认设备名来源
import { rcSetAudioLocalMute, rcHostMuteSet, type RcCapability } from "@/lib/api/rc";
import { confirmDialog } from "@/lib/confirm";
import { summonMainWindow } from "@/lib/rcWindow";
import styles from "./RemoteComputer.module.css";

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
          `「${p.peer_name || fingerprintOf(p.peer)}」申请远程本机（${
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

  // 被控中 / 有会话申请 / 有配对敲门 / 我方发起中 / 自动重连中 /
  // 无人值守固定密码开启（Q2 方案 C 的「常驻横幅」，设计稿第三条对策）才渲染
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
              : // D2：放权前必须先确认（它就挨着「立即结束」，误触代价不对称）
                () =>
                  void enableTrust(
                    session.peer,
                    session.peer_name || fingerprintOf(session.peer),
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
            void rc.end().then((ok) => {
              if (ok) toast("已结束远程会话", "success");
            });
          }}
        />
      )}
      {outboundLive && session && (
        <div className={styles.ctrlBanner} role="status">
          <span className={styles.who}>
            <span className={styles.live} />
            {session.phase === "outbound_pending"
              ? `正在申请远程「${session.peer_name || fingerprintOf(session.peer)}」`
              : `正在远程「${session.peer_name || fingerprintOf(session.peer)}」`}
          </span>
          <span className={styles.pillOn}>
            {session.capability === "control" ? "可控" : "只看"}
          </span>
          <span className={styles.sp} />
          {/* F-10：pending 与工作台 RcPendingWait 同口径——不说超时用户会干等到错误面板 */}
          <span className={styles.meta}>
            {session.phase === "outbound_pending"
              ? "等待对方同意 · 2 分钟内未响应将自动取消"
              : "打开「远程电脑」可看画面"}
          </span>
          {/* F-1 / U4：与被控横幅同一道 danger 确认——误触代价不对称；
              撤销窗口内的 toast 撤回仍免确认（可撤销优先）。 */}
          <button
            type="button"
            className={styles.dangerBtn}
            disabled={rc.busy}
            onClick={() => {
              void (async () => {
                const isPending = session.phase === "outbound_pending";
                const name = session.peer_name || fingerprintOf(session.peer);
                const ok = await confirmDialog({
                  title: isPending ? "取消远程申请" : "结束远程会话",
                  message: isPending
                    ? `将撤回对「${name}」的远程申请。对方若尚未同意，将不再看到这条申请。`
                    : `将断开与「${name}」的连接。你这边的画面与控制会立刻结束。`,
                  confirmText: isPending ? "取消申请" : "结束会话",
                  variant: "danger",
                });
                if (!ok) return;
                const done = await (isPending ? rc.cancel() : rc.end());
                if (done) {
                  toast(
                    isPending ? "已取消远程申请" : "已结束远程会话",
                    "success",
                  );
                }
              })();
            }}
          >
            {session.phase === "outbound_pending" ? "取消申请" : "立即结束"}
          </button>
        </div>
      )}
      {/* Q6：免确认设备异常断流 → 自动重连进度 / 失败提示。会话已被收口，
          不与上面两条横幅同时出现。 */}
      {reconnecting && !outboundLive && (
        <div className={styles.ctrlBanner} role="status" aria-live="polite">
          <span className={styles.who}>
            <span className={styles.live} />
            {reconnecting.gave_up
              ? `「${reconnecting.peer_name || fingerprintOf(reconnecting.peer)}」自动重连失败`
              : `「${reconnecting.peer_name || fingerprintOf(reconnecting.peer)}」连接中断，正在自动重连（${reconnecting.attempt}/${reconnecting.max}）`}
          </span>
          <span className={styles.sp} />
          <span className={styles.meta}>
            {reconnecting.gave_up
              ? "对方可能不在线；也可稍等对方恢复后自动恢复"
              : "对方是免确认设备，重连无需对方确认"}
          </span>
          {reconnecting.gave_up && (
            <button
              type="button"
              className={styles.miniBtn}
              disabled={rc.busy}
              title="立即向这台设备重新发起远程申请"
              onClick={() => {
                void rc
                  .request(reconnecting.peer, reconnecting.capability as RcCapability)
                  .then((ok) => {
                    if (ok) toast("已重新发起远程申请", "success");
                  });
              }}
            >
              重新发起
            </button>
          )}
        </div>
      )}
      <RcJoinRequests
        pending={pending}
        busy={rc.busy}
        onApprove={(id) => {
          void rc.approve(id).then((ok) => {
            if (ok) toast("已同意远程协助", "success");
          });
        }}
        onDeny={(id) => {
          void rc.deny(id).then((ok) => {
            if (ok) toast("已拒绝远程申请", "info");
          });
        }}
      />
      {joins.length > 0 && (
        <div className={styles.joinGlobal}>
          <h4>🔔 有 {joins.length} 台设备想完成远程配对</h4>
          {joins.map((j) => (
            <div key={j.node_id} className={styles.joinItem}>
              <div className={styles.joinFp}>{fingerprintOf(j.node_id)}</div>
              <div className={`${styles.meta} ${styles.joinHint}`}>
                核对指纹后再允许（与知识库同步配对无关）
              </div>
              <div className={styles.joinBtns}>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={rc.busy}
                  onClick={() => {
                    void rc.denyJoin(j.node_id).then((ok) => {
                      if (ok) toast("已拒绝配对", "info");
                    });
                  }}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={rc.busy}
                  onClick={() => {
                    void rc.approveJoin(j.node_id, DEFAULT_RC_DEVICE_NAME).then((ok) => {
                      if (ok) toast("已允许远程配对", "success");
                    });
                  }}
                >
                  允许配对
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Q2 方案 C：无人值守固定密码的**常驻**横幅。会话中被控横幅（RcControlBanner）
          已经在说「谁在控」，这里不叠加；除此之外的所有时刻都要挂着——
          一键全局关闭就在这条上，这是泄露密码后的止损按钮。 */}
      {unoPass && !inboundActive && (
        <div className={styles.ctrlBanner} role="status">
          <span className={styles.who}>
            <span className={styles.live} />
            无人值守模式中 · 固定密码接入已开启
          </span>
          <span className={styles.pillOn}>{unoPass.cap === "control" ? "可控" : "只看"}</span>
          <span className={styles.sp} />
          <span className={styles.meta}>
            {unoPass.wan ? "跨网已允许（有限速防爆破）" : "仅限同一局域网"}
          </span>
          <button
            type="button"
            className={styles.dangerBtn}
            disabled={rc.busy}
            onClick={() => {
              void rc.unoPassDisable().then((ok) => {
                if (ok) toast("已关闭无人值守固定密码", "success");
              });
            }}
          >
            一键关闭
          </button>
        </div>
      )}
    </>
  );
}