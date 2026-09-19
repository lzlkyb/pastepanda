/**
 * RcOverlay — 被控横幅 + 发起端会话横幅 + 入站确认条 + 配对敲门。挂在 App 层，**任何模式下都可见**（规则 15）。
 * 没人申请且未被控/未发起时返回 null，不占位。
 *
 * ❗ 只看 `rc_enabled`，**不**依赖知识库同步：远程通道是独立的（方案 A）。
 */
import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { useRc } from "@/hooks/useRc";
import { useRcTrustEnable } from "@/hooks/useRcTrustEnable";
import { useRcAdhoc } from "@/hooks/useRcAdhoc";
import { RcControlBanner } from "./RcControlBanner";
import { RcJoinRequests } from "./RcJoinRequests";
import { fingerprintOf } from "@/lib/fingerprint";
import { DEFAULT_RC_DEVICE_NAME } from "@/lib/rcDevice"; // C4：与 RcSection 统一默认设备名来源
import type { RcCapability } from "@/lib/api/rc";
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
        void (async () => {
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            const w = getCurrentWindow();
            if (!(await w.isVisible())) await w.show();
            await w.setFocus();
          } catch {
            /* 非 Tauri 或权限不足时忽略 */
          }
        })();
      }
    }
    // 清掉已消失的
    const alive = new Set(pending.map((p) => p.peer));
    for (const id of Array.from(seenPending.current)) {
      if (!alive.has(id)) seenPending.current.delete(id);
    }
  }, [rc.status?.pending, toast]);

  // 被控中 / 有会话申请 / 有配对敲门 / 我方发起中 / 自动重连中才渲染
  const session = rc.status?.session ?? null;
  const pending = rc.status?.pending ?? [];
  const joins = rc.status?.joins ?? [];
  // Q6：免确认设备异常断流后的自动重连进度（此时 session 已被收口）
  const reconnecting = rc.status?.reconnecting ?? null;
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

  if (!inboundActive && !outboundLive && pending.length === 0 && joins.length === 0 && !reconnecting) {
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
          <span className={styles.meta}>
            {session.phase === "outbound_pending"
              ? "等待对方同意"
              : "打开「远程电脑」可看画面"}
          </span>
          <button
            type="button"
            className={styles.dangerBtn}
            disabled={rc.busy}
            onClick={() => {
              void (session.phase === "outbound_pending"
                ? rc.cancel()
                : rc.end()
              ).then((ok) => {
                if (ok)
                  toast(
                    session.phase === "outbound_pending" ? "已取消远程申请" : "已结束远程会话",
                    "success",
                  );
              });
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
    </>
  );
}