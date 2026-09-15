/**
 * RcAllowPanel — 「允许被远程」开关下面的能力档 + 设备级限制。
 * 对齐设计稿 §二。主开关在 RcSection 的 ToggleRow 上。
 */
import type { RcStatus, RcTargetDevice } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { fingerprintOf } from "@/lib/fingerprint";
import styles from "../Settings.module.css";

export function RcAllowPanel({
  rc,
  status,
  targets,
}: {
  rc: UseRc;
  status: RcStatus;
  targets: RcTargetDevice[];
}) {
  const off = !status.enabled;

  return (
    <div className={styles.lanPanel} style={{ opacity: off ? 0.55 : 1 }}>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        仅限<b>已配对</b>设备；每次会话都要你在本机点同意。远程 shell / 文件管理
        <b>不做</b>。
      </div>

      {/* 能力上限：关主开关时仍可读、不可点（规则 15：变灰而不是消失） */}
      <div style={{ marginBottom: 14, pointerEvents: off ? "none" : "auto" }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>能力上限</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.6 }}>
          「可控」包含只看。对方申请的能力不能超过这里选的档。
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(
            [
              ["view", "只看"],
              ["control", "可控（含只看）"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={status.capability === k ? "btn-primary" : "btn-secondary"}
              style={{ fontSize: 12, padding: "4px 12px" }}
              disabled={off || rc.busy}
              onClick={() => void rc.setCapability(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 画质档 + 截取范围 */}
      <div style={{ marginTop: 14, marginBottom: 14, pointerEvents: off ? "none" : "auto" }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>画质档（被控端编码）</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.6 }}>
          流畅优先帧率、清晰优先分辨率；改后下次会话生效。
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(
            [
              ["smooth", "流畅"],
              ["balanced", "均衡"],
              ["sharp", "清晰"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={status.quality === k ? "btn-primary" : "btn-secondary"}
              style={{ fontSize: 12, padding: "4px 12px" }}
              disabled={off || rc.busy}
              onClick={() => void rc.setQuality(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, margin: "12px 0 6px" }}>画面范围</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(
            [
              ["virtual", "整个虚拟屏（含副屏）"],
              ["primary", "仅主屏"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={status.capture_scope === k ? "btn-primary" : "btn-secondary"}
              style={{ fontSize: 12, padding: "4px 12px" }}
              disabled={off || rc.busy}
              onClick={() => void rc.setCaptureScope(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 设备级：与同步暂停是两个开关 */}
      <div style={{ pointerEvents: off ? "none" : "auto" }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>设备级限制</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.6 }}>
          与「暂停同步」是<b>两个开关</b>：暂停停同步，这里停远程。
        </div>
        {targets.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            还没有配对设备。先在「远程电脑」里完成远程配对。
          </div>
        ) : (
          <div className={styles.lanDeviceList}>
            {targets.map((d) => {
              const denied = status.device_deny[d.node_id] ?? d.denied;
              return (
                <div key={d.node_id} className={styles.lanDeviceItem}>
                  <div
                    className={styles.lanDeviceAvatar}
                    style={{
                      background: `hsl(${((d.node_id.charCodeAt(0) || 0) * 40) % 360}, 60%, 55%)`,
                    }}
                  >
                    {(d.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div className={styles.lanDeviceInfo}>
                    <div className={styles.lanDeviceName}>{d.name || "未命名设备"}</div>
                    <div className={styles.lanDeviceTime}>
                      {fingerprintOf(d.node_id)} · {d.conn_state === "online" ? "在线" : "离线"}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: denied ? "var(--danger, #d64545)" : "var(--green, #2f9e5f)",
                      flexShrink: 0,
                    }}
                  >
                    {denied ? "已禁止" : "允许"}
                  </span>
                  <button
                    type="button"
                    className={styles.lanRefreshBtn}
                    style={{ flexShrink: 0 }}
                    disabled={off || rc.busy}
                    onClick={() => void rc.setDeviceAllowed(d.node_id, denied)}
                  >
                    {denied ? "允许" : "关闭"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
