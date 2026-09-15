/**
 * RcOverlay — 被控横幅 + 入站确认条 + 配对敲门。挂在 App 层，**任何模式下都可见**（规则 15）。
 * 没人申请且未被控时返回 null，不占位。
 *
 * ❗ 只看 `rc_enabled`，**不**依赖知识库同步：远程通道是独立的（方案 A）。
 */
import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { useRc } from "@/hooks/useRc";
import { RcControlBanner } from "./RcControlBanner";
import { RcJoinRequests } from "./RcJoinRequests";
import { fingerprintOf } from "@/lib/fingerprint";
import styles from "./RemoteComputer.module.css";

export function RcOverlay() {
  const { toast } = useToast();
  // 始终轮询：配对敲门可能在未开「允许被远程」时到达；轮询本身受窗口可见性门控
  const rc = useRc(true);
  const seenPending = useRef(new Set<string>());

  // 窗口可能 hide：有新申请时 toast，避免 120s 超时前用户毫无感知
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
      }
    }
    // 清掉已消失的
    const alive = new Set(pending.map((p) => p.peer));
    for (const id of Array.from(seenPending.current)) {
      if (!alive.has(id)) seenPending.current.delete(id);
    }
  }, [rc.status?.pending, toast]);

  // 被控中 / 有会话申请 / 有配对敲门时才渲染
  const session = rc.status?.session ?? null;
  const pending = rc.status?.pending ?? [];
  const joins = rc.status?.joins ?? [];
  const inboundActive = session?.phase === "inbound_active";
  if (!inboundActive && pending.length === 0 && joins.length === 0) return null;

  return (
    <>
      {inboundActive && session && (
        <RcControlBanner
          session={session}
          busy={rc.busy}
          onEnd={() => {
            void rc.end().then((ok) => {
              if (ok) toast("已结束远程会话", "success");
            });
          }}
        />
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
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            🔔 有 {joins.length} 台设备想完成远程配对
          </div>
          {joins.map((j) => (
            <div key={j.node_id} style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: "ui-monospace, Consolas, monospace", fontWeight: 700 }}>
                {fingerprintOf(j.node_id)}
              </div>
              <div className={styles.meta} style={{ margin: "4px 0 8px" }}>
                核对指纹后再允许（与知识库同步配对无关）
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
                    void rc.approveJoin(j.node_id, "新设备").then((ok) => {
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
