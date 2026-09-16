/**
 * RcOverlay — 被控横幅 + 发起端会话横幅 + 入站确认条 + 配对敲门。挂在 App 层，**任何模式下都可见**（规则 15）。
 * 没人申请且未被控/未发起时返回 null，不占位。
 *
 * ❗ 只看 `rc_enabled`，**不**依赖知识库同步：远程通道是独立的（方案 A）。
 */
import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { useRc } from "@/hooks/useRc";
import { RcControlBanner } from "./RcControlBanner";
import { RcJoinRequests } from "./RcJoinRequests";
import { fingerprintOf } from "@/lib/fingerprint";
import { DEFAULT_RC_DEVICE_NAME } from "@/lib/rcDevice"; // C4：与 RcSection 统一默认设备名来源
import styles from "./RemoteComputer.module.css";

export function RcOverlay() {
  const { toast } = useToast();
  // 始终轮询：配对敲门可能在未开「允许被远程」时到达；轮询本身受窗口可见性门控
  const rc = useRc(true);
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

  // 被控中 / 有会话申请 / 有配对敲门 / 我方发起中时才渲染
  const session = rc.status?.session ?? null;
  const pending = rc.status?.pending ?? [];
  const joins = rc.status?.joins ?? [];
  const inboundActive = session?.phase === "inbound_active";
  const outboundLive =
    session?.phase === "outbound_active" || session?.phase === "outbound_pending";
  if (!inboundActive && !outboundLive && pending.length === 0 && joins.length === 0) {
    return null;
  }

  return (
    <>
      {inboundActive && session && (
        <RcControlBanner
          session={session}
          busy={rc.busy}
          scopeNotice={rc.scopeNotice}
          onDismissScopeNotice={rc.clearScopeNotice}
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