/**
 * RcDeviceList — 设备卡片：可达性档位 / 上次控制 / 禁止 / 忘记 / 菜单。
 *
 * 🔴 不再用二值「在线/离线」：无中心服务器时组播听不见 ≠ 对端关机。
 * 四档文案见 `rcDevice.presenceMainLabel` 与 design/远程设备多档在线状态-设计稿.html。
 */
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { confirmDialog } from "@/lib/confirm";
import type { RcTargetDevice } from "@/lib/api/rc";
import {
  deviceAvatarStyle,
  relTime,
  presenceMainLabel,
  presenceHint,
  presenceDotClass,
  type RcPresenceLevel,
} from "@/lib/rcDevice";
import styles from "./RemoteComputer.module.css";

function normalizePresence(raw: string | undefined): RcPresenceLevel {
  if (raw === "live" || raw === "recent" || raw === "seen" || raw === "never") {
    return raw;
  }
  // 旧字段兜底：后端未带 presence 时按「见过」处理，不假装在线
  return "seen";
}

export function RcDeviceList({
  targets,
  lastPeer,
  deviceDeny,
  busy,
  onRequest,
  onForget,
  onSetAllowed,
  onPair,
  toast,
}: {
  targets: RcTargetDevice[];
  lastPeer: string | null;
  deviceDeny: Record<string, boolean>;
  busy: boolean;
  onRequest: (id: string) => void;
  onForget: (id: string) => Promise<boolean>;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  /** B9：纯同步配对设备「列得出却发不起」，给一个去完成远程配对的入口。 */
  onPair?: () => void;
  toast: (m: string, k: "success" | "error" | "info") => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

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

  // C9：函数名为「deny」却在「允许」——改名 setAllowed，与行为一致。
  const setAllowed = async (id: string, currentlyDenied: boolean) => {
    if (await onSetAllowed(id, !currentlyDenied)) {
      toast(
        currentlyDenied ? "已允许该设备远程本机" : "已禁止该设备远程本机",
        "success",
      );
      setMenuFor(null);
    }
  };

  return (
    <div className={styles.devList} ref={listRef}>
      {targets.map((d) => {
        const presence = normalizePresence(d.presence);
        const isLast = d.node_id === lastPeer;
        const denied = deviceDeny[d.node_id] ?? d.denied;
        const lastSeen = relTime(d.last_seen); // D4
        const syncOnly = d.source === "sync"; // B9
        const mainLabel = presenceMainLabel(presence, lastSeen);
        const hint = presenceHint(presence);
        const dotKey = presenceDotClass(presence);
        const dotCls =
          dotKey === "dotOn"
            ? styles.dotOn
            : dotKey === "dotRecent"
              ? styles.dotRecent
              : styles.dotOff;
        return (
          <div
            key={d.node_id}
            className={isLast ? `${styles.devItem} ${styles.devItemRecent}` : styles.devItem}
          >
            {/* D1/C10：头像颜色来自公共纯函数（单色系 + 深色文字），删掉内联随机 hsl */}
            <div className={styles.av} style={deviceAvatarStyle(d.node_id)}>
              {(d.name || "?").charAt(0).toUpperCase()}
            </div>
            <div className={styles.info}>
              <div className={styles.name}>
                {d.name || "未命名设备"}
                {isLast && <span className={styles.tagRecent}>上次</span>}
                <span className={syncOnly ? styles.tagSync : styles.tagRc}>
                  {syncOnly ? "同步" : "远程"}
                </span>
                {denied && <span className={styles.tagDenied}>已禁止控本机</span>}
              </div>
              <div className={styles.meta}>
                <span className={dotCls} />
                {mainLabel} · {fingerprintOf(d.node_id)} · {hint}
                {presence !== "recent" && presence !== "live" && lastSeen && d.last_seen > 0 && (
                  <span className={styles.metaSub}> · 上次 {lastSeen}</span>
                )}
                {syncOnly && " · 仅同步配对，未建立远程通道"}
              </div>
            </div>
            {denied && (
              <button
                type="button"
                className={styles.miniBtn}
                disabled={busy}
                title="解除后对方才能申请远程本机"
                onClick={() => void setAllowed(d.node_id, true)}
              >
                解除禁止
              </button>
            )}
            {/* B9：纯同步配对设备列得出却发不起 —— 不做「远程」按钮，给下一步指引 */}
            {syncOnly ? (
              <button
                type="button"
                className={styles.miniBtn}
                disabled={busy || !onPair}
                title="仅同步配对，未建立远程通道 · 去完成远程配对"
                onClick={() => onPair?.()}
              >
                去配对
              </button>
            ) : (
              // 禁止的是「对方控我」，不挡「我去远程对方」
              <button
                type="button"
                className={styles.miniBtnPri}
                disabled={busy}
                title={
                  presence === "live"
                    ? "发送远程申请"
                    : "未听到局域网宣告，将尝试公网直连或中继"
                }
                onClick={() => onRequest(d.node_id)}
              >
                远程
              </button>
            )}
            <div className={styles.devMenuWrap}>
              {/* D5/L2：图标旁补常驻文字标签「更多」 */}
              <button
                type="button"
                className={styles.miniBtn}
                aria-label="更多操作"
                onClick={() => setMenuFor(menuFor === d.node_id ? null : d.node_id)}
              >
                <MoreHorizontal size={14} />
                更多
              </button>
              {menuFor === d.node_id && (
                <div className={styles.devMenu}>
                  {!denied && !syncOnly && (
                    <button type="button" onClick={() => void setAllowed(d.node_id, false)}>
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