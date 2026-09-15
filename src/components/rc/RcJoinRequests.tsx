/**
 * RcJoinRequests — 入站申请确认条。Enter=同意 / Esc=拒绝（鼠标仍完整可达）。
 */
import { useEffect } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import type { RcInboundKnock } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcJoinRequests({
  pending,
  busy,
  onApprove,
  onDeny,
}: {
  pending: RcInboundKnock[];
  busy: boolean;
  onApprove: (nodeId: string) => void;
  onDeny: (nodeId: string) => void;
}) {
  const first = pending[0];

  useEffect(() => {
    if (!first) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Enter") {
        e.preventDefault();
        onApprove(first.peer);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDeny(first.peer);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [first, onApprove, onDeny]);

  if (pending.length === 0) return null;

  return (
    <div className={styles.joinGlobal}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        🔔 有 {pending.length} 台设备想远程这台电脑
      </div>
      {pending.map((r) => (
        <div key={r.peer} style={{ marginBottom: 8 }}>
          <div className={styles.meta} style={{ marginBottom: 4 }}>
            对方指纹
          </div>
          <div style={{ fontFamily: "ui-monospace, Consolas, monospace", fontWeight: 700 }}>
            {fingerprintOf(r.peer)}
          </div>
          <p style={{ margin: "6px 0 8px" }}>
            申请能力：<b>{r.capability === "control" ? "可控（含只看）" : "只看"}</b>
            {r.peer_name ? ` · 设备名「${r.peer_name}」（可自称，以指纹为准）` : ""}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
            <span className={styles.kbdHint}>
              <kbd>Enter</kbd> 同意 · <kbd>Esc</kbd> 拒绝
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => onDeny(r.peer)}
            >
              拒绝
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => onApprove(r.peer)}
            >
              同意远程
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
