/**
 * RcAllowPanel — 「允许被远程」开关下面的能力档 + 设备级限制。
 * 对齐设计稿 §二。主开关在 RcSection 的 ToggleRow 上。
 *
 * D11：原先这里的间距/字号/颜色全是内联 style（21 处），现在统一收口到
 * `./RcSettings.module.css` 的 rc* 类（2026-09-16 从 Settings.module.css 拆出）；
 * 只有 deviceAvatarStyle（按设备 id 派生）是真正的动态值，保留在 style 上。
 * `shared` 是设置页共用的那几个类（sRow/sSection 等）。
 */
import type { RcMonitorInfo, RcStatus, RcTargetDevice } from "@/lib/api/rc";
import { rcListMonitors, rcEncodeCaps } from "@/lib/api/rc";
import { useEffect, useState } from "react";
import type { UseRc } from "@/hooks/useRc";
import { fingerprintOf } from "@/lib/fingerprint";
import { deviceAvatarStyle, presenceMainLabel, relTime } from "@/lib/rcDevice"; // D1/C10：与 RcDeviceList 共用公共纯函数
import { visibleQualities, qualityLabel } from "@/lib/rcQuality";
import { scopeOptions } from "@/lib/rcScope";
import { useToast } from "@/components/Toast";
import shared from "../Settings.module.css";
import styles from "./RcSettings.module.css";

/**
 * 一组档位按钮，选中态与禁用态规则一致，抽出来避免三处重复。
 * `tip` 是悬停说明——画质/范围的补充事实（fps、分辨率、含不含副屏）都放那里，
 * 不挤进按钮文案（见 lib/rcQuality 的收口说明）。
 */
function ChoiceRow<T extends string>({
  options,
  value,
  disabled,
  onPick,
}: {
  options: readonly { key: T; label: string; tip?: string }[];
  value: string;
  disabled: boolean;
  onPick: (v: T) => void;
}) {
  return (
    <div className={styles.rcBtnRow}>
      {options.map(({ key, label, tip }) => (
        <button
          key={key}
          type="button"
          title={tip}
          className={`${value === key ? "btn-primary" : "btn-secondary"} ${styles.rcChoiceBtn}`}
          disabled={disabled}
          onClick={() => onPick(key)}
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
  const { toast } = useToast();
  // 关主开关时：整块降透明度，且交互区禁用（说明文字仍可读）
  const gate = off ? styles.rcGated : undefined;
  // 逐屏档要本机显示器列表——这里配的是「本机作为被控端」时的采集范围，所以是本机的屏
  const [monitors, setMonitors] = useState<RcMonitorInfo[]>([]);
  // P1：fps120 档门控要本机编码能力（硬件 D3D11-aware MFT + 刷新率）
  const [caps, setCaps] = useState<{ h264_gpu: boolean; hevc_hw: boolean; refresh_hz: number } | null>(null);
  useEffect(() => {
    void rcListMonitors()
      .then(setMonitors)
      .catch(() => setMonitors([]));
    void rcEncodeCaps()
      .then(setCaps)
      .catch(() => setCaps(null));
  }, []);
  const qualities = visibleQualities({
    h264Gpu: caps?.h264_gpu,
    refreshHz: caps?.refresh_hz,
    // Q3/Q4：uhd60 档的判定还要本机 HEVC 硬编（缺了它 4K60 档在设置页永远不出现）
    hevcHw: caps?.hevc_hw,
  });

  return (
    <div className={`${shared.lanPanel} ${off ? styles.rcPanelOff : ""}`}>
      <div className={styles.rcIntro}>
        仅限<b>已配对</b>设备；默认每次远程都要你在本机点同意，可对单台设备开「免确认」跳过。
        远程 shell / 文件管理<b>不做</b>。
      </div>

      {/* 能力上限：关主开关时仍可读、不可点（规则 15：变灰而不是消失） */}
      <div className={`${styles.rcBlock} ${gate ?? ""}`}>
        <div className={styles.rcLabel}>能力上限</div>
        <div className={styles.rcHint}>「可控」包含只看。对方申请的能力不能超过这里选的档。</div>
        <ChoiceRow
          options={
            [
              { key: "view", label: "只看" },
              { key: "control", label: "可控（含只看）" },
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
        <div className={styles.rcHint}>
          默认「自动」：会话中按延迟与带宽在 流畅/均衡/清晰/超清 间自动切换；选其它档即锁定。
        </div>
        {/* 与「远程电脑」面板的画质条共用同一张档位表（lib/rcQuality）；
            fps120 档只在能力达标（P1 visibleQualities）时出现 */}
        <ChoiceRow
          options={qualities}
          value={status.quality}
          disabled={off || rc.busy}
          onPick={(k) => void rc.setQuality(k)}
        />
        {status.quality === "auto" && (
          <div className={styles.rcHint}>
            {/* 「生效档」只在本机正被控（= 本机在推流）时才存在：换档发生在推流循环里。
                没有会话时报一个档名会让人以为它此刻正在生效（后端此时返回的也只是配置档）。 */}
            {status.session?.phase === "inbound_active"
              ? `当前生效：${qualityLabel(status.active_quality ?? "balanced")}`
              : "有人连进来后：从「均衡」起跑，再按链路自动升降档"}
          </div>
        )}
        <div className={styles.rcLabelTop}>画面范围</div>
        {/* 与画质条共用 scopeOptions：改前这里只有「整个虚拟屏 / 仅主屏」两项，缺逐屏 */}
        <ChoiceRow
          options={scopeOptions(monitors)}
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
          <div className={shared.lanDeviceList}>
            {targets.map((d) => {
              const denied = status.device_deny[d.node_id] ?? d.denied;
              // 方案 D「免确认直连」：逐台开关，默认关。被禁止的设备先解除禁止
              // 才谈得上免确认（deny 优先级更高，按钮直接禁用把这件事说在明处）。
              const trusted = d.trusted ?? false;
              // A4：设备名与工作台同一口径（备注优先、自报名兜底）。设置页只用 d.name
              // 时，起过备注的设备在这两处会显示成两个名字。
              const displayName = d.note?.trim() || d.name || "未命名设备";
              return (
                <div key={d.node_id} className={shared.lanDeviceItem}>
                  <div className={shared.lanDeviceAvatar} style={deviceAvatarStyle(d.node_id)}>
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className={shared.lanDeviceInfo}>
                    <div className={shared.lanDeviceName}>{displayName}</div>
                    <div className={shared.lanDeviceTime}>
                      {fingerprintOf(d.node_id)} ·{" "}
                      {presenceMainLabel(
                        (d.presence as "live" | "recent" | "seen" | "never") || "seen",
                        relTime(d.last_seen),
                      )}
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
                    className={`${shared.lanRefreshBtn} ${styles.rcDevBtn}`}
                    disabled={off || rc.busy || denied}
                    title={
                      denied
                        ? "该设备已被禁止远程本机；先点「允许」解除禁止再谈免确认"
                        : trusted
                          ? "这台设备远程本机不再逐次询问。点击恢复每次询问"
                          : "开启后这台设备发起远程时不再逐次询问你（仍是已配对设备，可随时关回）"
                    }
                    onClick={() => {
                      const next = !trusted;
                      void rc.setDeviceTrust(d.node_id, next).then((ok) => {
                        if (ok && next) {
                          toast(
                            `已对「${displayName}」开启免确认：它发起远程时不再询问你`,
                            "success",
                          );
                        }
                      });
                    }}
                  >
                    {trusted ? "免确认·开" : "免确认"}
                  </button>
                  <button
                    type="button"
                    className={`${shared.lanRefreshBtn} ${styles.rcDevBtn}`}
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
