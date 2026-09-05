import { useState } from "react";
import { useKbSync, type KbDevice } from "@/hooks/useKbSync";
import { KbPairDialog, fingerprintOf } from "./KbPairDialog";
import styles from "../Settings.module.css";

/** 「12 秒前」这种相对时间。0 = 从未同步过。 */
function ago(ms: number): string {
  if (!ms) return "还没同步过";
  const d = Date.now() - ms;
  if (d < 0) return "刚刚";
  if (d < 60_000) return `${Math.floor(d / 1000)} 秒前同步`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前同步`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前同步`;
  return `${Math.floor(d / 86_400_000)} 天前同步`;
}

/**
 * 「知识库同步」开关下面那块面板。
 *
 * 结构照 `LanSyncPanel`（同一套 `styles.lanPanel` 类），因为它就是同一种东西：
 * 一个开关下面挂设备列表。用户在设置页里看到两块长得一样的，
 * 正好对上「一个同步剪贴板、一个同步笔记」。
 */
export function KbSyncPanel({ toast }: {
  toast: (m: string, t?: "success" | "error" | "info") => void;
}) {
  const s = useKbSync(true, toast);
  const [dialog, setDialog] = useState<"create" | "paste" | null>(null);
  const [confirmForget, setConfirmForget] = useState<KbDevice | null>(null);

  const online = s.devices.filter((d) => s.live.includes(d.node_id)).length;
  const fp = s.identity?.fingerprint ?? "读取中…";

  return (
    <div className={styles.lanPanel}>
      <div className={styles.lanPanelHeader}>
        <div className={styles.lanStatus}>
          {/* 点跟随真实状态：一台都不在线就是灰的，不恒亮假绿（LanSyncPanel 改过这个） */}
          <div className={`${styles.lanDot}${online === 0 ? ` ${styles.off}` : ""}`} />
          <span className={styles.lanStatusText}>
            {s.devices.length === 0
              ? "还没有配对任何设备"
              : `${s.devices.length} 台设备已配对，${online} 台在线`}
          </span>
        </div>
        {s.devices.length > 0 && (
          <button className={styles.lanRefreshBtn} onClick={() => s.refreshDevices()} disabled={s.busy}>
            🔄 刷新
          </button>
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        笔记<b>只在你的设备之间直连传输</b>，不经过任何服务器。
      </div>

      {s.devices.length === 0 ? (
        <>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 5 }}>
            本机指纹（用来让对方确认是你）
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <span style={{
              fontFamily: "ui-monospace, Consolas, monospace", fontSize: 15,
              letterSpacing: 2, fontWeight: 700,
            }}>{fp}</span>
            <button className={styles.lanRefreshBtn} onClick={async () => {
              try {
                await navigator.clipboard.writeText(fp);
                toast("已复制本机指纹", "success");
              } catch { toast("复制失败，请手动选中复制", "error"); }
            }}>📋 复制</button>
          </div>
          {/* ❗ 身份没读到时禁用：弹窗本身需要 `identity.fingerprint`，
              不禁的话点下去**什么都不会发生**（规则 #15.3）。
              读失败的原因 refreshIdentity 已经弹过 toast 了。 */}
          <div style={{ display: "flex", gap: 8 }}>
            <button className={styles.lanTestBtn} style={{ flex: 1 }}
              disabled={!s.identity} onClick={() => setDialog("create")}>
              ➕ 生成邀请码
            </button>
            <button className={styles.lanRefreshBtn} style={{ flex: 1 }}
              disabled={!s.identity} onClick={() => setDialog("paste")}>
              📥 粘贴对方的邀请码
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.lanDeviceList}>
            {s.devices.map((d) => {
              const isOnline = s.live.includes(d.node_id);
              return (
                <div key={d.node_id} className={styles.lanDeviceItem}>
                  <div className={styles.lanDeviceAvatar} style={{
                    background: `hsl(${(d.node_id.charCodeAt(0) || 0) * 40 % 360}, 60%, 55%)`,
                  }}>{d.name.charAt(0).toUpperCase()}</div>
                  <div className={styles.lanDeviceInfo}>
                    <div className={styles.lanDeviceName}>{d.name}</div>
                    <div className={styles.lanDeviceTime}>
                      {fingerprintOf(d.node_id)} · {ago(d.last_seen)}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 10, padding: "2px 7px", borderRadius: 20,
                    background: isOnline ? "var(--green-bg)" : "var(--card-bg)",
                    color: isOnline ? "var(--green)" : "var(--text-secondary)",
                    border: `1px solid ${isOnline ? "var(--green-border)" : "var(--border-color)"}`,
                  }}>
                    {isOnline ? (d.transport === "wan" ? "外网" : "局域网") : "离线"}
                  </span>
                  <button className={styles.lanRefreshBtn} disabled={s.busy}
                    onClick={() => s.syncNow(d.node_id)}>⇅</button>
                  <button className={styles.lanRefreshBtn} disabled={s.busy}
                    style={{ color: "var(--danger)" }}
                    onClick={() => setConfirmForget(d)}>忘记</button>
                </div>
              );
            })}
          </div>
          <div style={{
            marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--border-color)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>本机指纹 {fp}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className={styles.lanRefreshBtn} disabled={!s.identity}
                onClick={() => setDialog("create")}>➕ 邀请</button>
              <button className={styles.lanRefreshBtn} disabled={!s.identity}
                onClick={() => setDialog("paste")}>📥 粘贴</button>
            </div>
          </div>
        </>
      )}

      {dialog && s.identity && (
        <KbPairDialog
          mode={dialog}
          myFingerprint={s.identity.fingerprint}
          onClose={() => setDialog(null)}
          onCreateInvite={s.createInvite}
          onPreview={s.previewInvite}
          onPair={s.pair}
          toast={toast}
        />
      )}

      {confirmForget && (
        <div className="dialog-backdrop" onClick={() => setConfirmForget(null)}>
          <div className="dialog-box dialog-solid w420" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header"><h2 className="dialog-title">忘记「{confirmForget.name}」？</h2></div>
            <div className="dialog-body" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <p style={{ margin: "0 0 8px" }}>本机不再与它同步，已同步过来的笔记<b>不会被删</b>。</p>
              {/* 说清后果：只忘一边的话对方会一直白拨，用户看到「连不上」会以为是 bug */}
              <p style={{ margin: 0, color: "var(--text-muted)" }}>
                ❗ 对方那台机器上<b>还留着这台的记录</b>，它会继续尝试连接并被拒绝。
                想彻底断开，请在两边都忘记一次。
              </p>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setConfirmForget(null)}>取消</button>
              <button className="btn btn-danger" disabled={s.busy} onClick={async () => {
                await s.forget(confirmForget.node_id);
                toast(`已忘记「${confirmForget.name}」`, "success");
                setConfirmForget(null);
              }}>忘记此设备</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
