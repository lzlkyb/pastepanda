/**
 * RcDeviceList — 设备卡片：在线态 / 上次 / 禁止 / 忘记 / 菜单。
 */
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { confirmDialog } from "@/lib/confirm";
import type { RcTargetDevice } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcDeviceList({
  targets,
  lastPeer,
  deviceDeny,
  busy,
  onRequest,
  onForget,
  onSetAllowed,
  toast,
}: {
  targets: RcTargetDevice[];
  lastPeer: string | null;
  deviceDeny: Record<string, boolean>;
  busy: boolean;
  onRequest: (id: string) => void;
  onForget: (id: string) => Promise<boolean>;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  toast: (m: string, k: "success" | "error" | "info") => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const forget = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: "忘记此设备",
      message: `将从远程配对列表移除「${name}」。之后需要重新配对才能远程。`,
      confirmText: "忘记",
      variant: "danger",
    });
    if (!ok) return;
    if (await onForget(id)) {
      toast("已忘记该设备", "success");
      setMenuFor(null);
    }
  };

  const deny = async (id: string, currentlyDenied: boolean) => {
    if (await onSetAllowed(id, !currentlyDenied)) {
      toast(
        currentlyDenied ? "已允许该设备远程本机" : "已禁止该设备远程本机",
        "success",
      );
      setMenuFor(null);
    }
  };

  return (
    <div className={styles.devList}>
      {targets.map((d) => {
        const online = d.conn_state === "online";
        const isLast = d.node_id === lastPeer;
        const denied = deviceDeny[d.node_id] ?? d.denied;
        return (
          <div
            key={d.node_id}
            className={isLast ? `${styles.devItem} ${styles.devItemRecent}` : styles.devItem}
          >
            <div
              className={styles.av}
              style={{
                background: `hsl(${((d.node_id.charCodeAt(0) || 0) * 40) % 360}, 60%, 55%)`,
              }}
            >
              {(d.name || "?").charAt(0).toUpperCase()}
            </div>
            <div className={styles.info}>
              <div className={styles.name}>
                {d.name || "未命名设备"}
                {isLast && <span className={styles.tagRecent}>上次</span>}
                <span className={d.source === "sync" ? styles.tagSync : styles.tagRc}>
                  {d.source === "sync" ? "同步" : "远程"}
                </span>
                {denied && <span className={styles.tagDenied}>已禁止控本机</span>}
              </div>
              <div className={styles.meta}>
                <span className={online ? styles.dotOn : styles.dotOff} />
                {online ? "在线" : "离线"} · {fingerprintOf(d.node_id)}
                {!online && " · 仍可经中继尝试"}
              </div>
            </div>
            {denied ? (
              <button
                type="button"
                className={styles.miniBtn}
                disabled={busy}
                title="解除后对方才能申请远程本机"
                onClick={() => void deny(d.node_id, true)}
              >
                解除禁止
              </button>
            ) : (
              <button
                type="button"
                className={styles.miniBtnPri}
                disabled={busy}
                title={
                  online ? "发送远程申请" : "未听到局域网宣告，仍可尝试（可能经中继）"
                }
                onClick={() => onRequest(d.node_id)}
              >
                远程
              </button>
            )}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className={styles.miniBtn}
                aria-label="更多操作"
                onClick={() => setMenuFor(menuFor === d.node_id ? null : d.node_id)}
              >
                <MoreHorizontal size={14} />
              </button>
              {menuFor === d.node_id && (
                <div className={styles.devMenu}>
                  {!denied && (
                    <button type="button" onClick={() => void deny(d.node_id, false)}>
                      禁止远程本机
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void forget(d.node_id, d.name || "该设备")}
                  >
                    忘记设备
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
