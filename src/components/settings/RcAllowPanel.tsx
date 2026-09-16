/**
 * RcAllowPanel — 「允许被远程」开关下面的能力档 + 设备级限制。
 * 对齐设计稿 §二。主开关在 RcSection 的 ToggleRow 上。
 *
 * D11：原先这里的间距/字号/颜色全是内联 style（21 处），现在统一收口到
 * Settings.module.css 的 rc* 类；只有 deviceAvatarStyle（按设备 id 派生）
 * 是真正的动态值，保留在 style 上。
 */
import type { RcStatus, RcTargetDevice } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { fingerprintOf } from "@/lib/fingerprint";
import { deviceAvatarStyle } from "@/lib/rcDevice"; // D1/C10：与 RcDeviceList 共用公共纯函数
import styles from "../Settings.module.css";

/** 一组「二选一/三选一」的档位按钮，选中态与禁用态规则一致，抽出来避免三处重复。 */
function ChoiceRow<T extends string>({
  options,
  value,
  disabled,
  onPick,
}: {
  options: readonly (readonly [T, string])[];
  value: string;
  disabled: boolean;
  onPick: (v: T) => void;
}) {
  return (
    <div className={styles.rcBtnRow}>
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          className={`${value === k ? "btn-primary" : "btn-secondary"} ${styles.rcChoiceBtn}`}
          disabled={disabled}
          onClick={() => onPick(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

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
  // 关主开关时：整块降透明度，且交互区禁用（说明文字仍可读）
  const gate = off ? styles.rcGated : undefined;

  return (
    <div className={`${styles.lanPanel} ${off ? styles.rcPanelOff : ""}`}>
      <div className={styles.rcIntro}>
        仅限<b>已配对</b>设备；每次会话都要你在本机点同意。远程 shell / 文件管理
        <b>不做</b>。
      </div>

      {/* 能力上限：关主开关时仍可读、不可点（规则 15：变灰而不是消失） */}
      <div className={`${styles.rcBlock} ${gate ?? ""}`}>
        <div className={styles.rcLabel}>能力上限</div>
        <div className={styles.rcHint}>「可控」包含只看。对方申请的能力不能超过这里选的档。</div>
        <ChoiceRow
          options={
            [
              ["view", "只看"],
              ["control", "可控（含只看）"],
            ] as const
          }
          value={status.capability}
          disabled={off || rc.busy}
          onPick={(k) => void rc.setCapability(k)}
        />
      </div>

      {/* 画质档 + 截取范围 */}
      <div className={`${styles.rcBlockSpaced} ${gate ?? ""}`}>
        <div className={styles.rcLabel}>画质档（被控端编码）</div>
        <div className={styles.rcHint}>流畅优先帧率、清晰优先分辨率；改后下次会话生效。</div>
        <ChoiceRow
          options={
            [
              ["smooth", "流畅"],
              ["balanced", "均衡"],
              ["sharp", "清晰"],
            ] as const
          }
          value={status.quality}
          disabled={off || rc.busy}
          onPick={(k) => void rc.setQuality(k)}
        />
        <div className={styles.rcLabelTop}>画面范围</div>
        <ChoiceRow
          options={
            [
              ["virtual", "整个虚拟屏（含副屏）"],
              ["primary", "仅主屏"],
            ] as const
          }
          value={status.capture_scope}
          disabled={off || rc.busy}
          onPick={(k) => void rc.setCaptureScope(k)}
        />
      </div>

      {/* 设备级：与同步暂停是两个开关 */}
      <div className={gate}>
        <div className={styles.rcLabel}>设备级限制</div>
        <div className={styles.rcHint}>
          与「暂停同步」是<b>两个开关</b>：暂停停同步，这里停远程。
        </div>
        {targets.length === 0 ? (
          <div className={styles.rcEmpty}>还没有配对设备。先在「远程电脑」里完成远程配对。</div>
        ) : (
          <div className={styles.lanDeviceList}>
            {targets.map((d) => {
              const denied = status.device_deny[d.node_id] ?? d.denied;
              return (
                <div key={d.node_id} className={styles.lanDeviceItem}>
                  <div className={styles.lanDeviceAvatar} style={deviceAvatarStyle(d.node_id)}>
                    {(d.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div className={styles.lanDeviceInfo}>
                    <div className={styles.lanDeviceName}>{d.name || "未命名设备"}</div>
                    <div className={styles.lanDeviceTime}>
                      {fingerprintOf(d.node_id)} · {d.conn_state === "online" ? "在线" : "离线"}
                    </div>
                  </div>
                  <span
                    className={`${styles.rcDevState} ${
                      denied ? styles.rcDevStateOff : styles.rcDevStateOn
                    }`}
                  >
                    {denied ? "已禁止" : "允许"}
                  </span>
                  <button
                    type="button"
                    className={`${styles.lanRefreshBtn} ${styles.rcDevBtn}`}
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
