/**
 * RcCapGroup — 组 3「被控上限」。
 *
 * 三行：能力上限（两档 → `sSegGroup`）、画质档、画面范围（≥3 档 → `RcDropdown`）。
 * 🔴 分流判据是**档数**，不是喜好：一行右控件列实测只剩 72–96px（设计稿 §2 现场量的），
 * 11 档画质平铺要 3 行。两档才允许用页内已有的分段按钮。
 *
 * 档位数据一律吃 `lib/rcQuality` / `lib/rcScope` 的现成表（`label + meta + solo`），
 * 与工作台会话条同一来源——设置页此前自己拼了一套满宽按钮，是第二份实现。
 *
 * 本机能力（显示器 / 编码）由编排层的 `useRcLocalAbility` 读一次传进来：
 * 放在本组件里会随着组收起卸载，每次展开重读一遍。
 */
import { rcCanControl, rcCapShort } from "@/lib/rcCapability";
import type { UseRc } from "@/hooks/useRc";
import type { RcCaptureScope, RcQuality, RcStatus } from "@/lib/api/rc";
import type { RcLocalAbility } from "@/hooks/useRcLocalAbility";
import { qualityLabel } from "@/lib/rcQuality";
import { scopeLabel, scopeOptions } from "@/lib/rcScope";
import { RcDropdown } from "@/components/rc/RcDropdown";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";
import { RcGroupHead } from "./RcGroupHead";
import { RcGroupRow } from "./RcGroupRow";

export function RcCapGroup({
  rc,
  status,
  ability,
  open,
  inert,
  onToggle,
}: {
  rc: UseRc;
  status: RcStatus;
  ability: RcLocalAbility;
  open: boolean;
  /** 搜索态：组头停止响应点击（见 RcGroupHead）。 */
  inert?: boolean;
  onToggle: () => void;
}) {
  const { loadError, reload, capsUnknown, monitorsUnknown, qualities, monitors } = ability;
  // 🔴 判据用**后端真值** `status.enabled`，不是 `config.rc_enabled`：这三行配的就是
  // 「通道开着时能被怎么控」，原 `RcAllowPanel` 也是这条口径（两者只在切换在飞的
  // 短暂窗口里不一致，真值不会让界面显示成「能改但其实改了不生效」）。
  const off = !status.enabled;
  const busy = off || rc.busy;

  return (
    <>
      <RcGroupHead
        label="被控上限"
        open={open}
        inert={inert}
        off={off}
        onToggle={onToggle}
        summary={
          <>
            上限<b>{rcCapShort(status.capability)}</b> · 画质
            <b>{qualityLabel(status.quality)}</b> · 范围<b>{scopeLabel(status.capture_scope)}</b>
          </>
        }
      />
      {open && (
        <>
          {/* U3.5：读失败出错误条 + 重试，禁止落成「本机没这个能力」 */}
          {loadError && (
            <div className={`${styles.rcLoadError} ${styles.rcBlockTop}`} role="alert">
              <span>{loadError}</span>
              <button type="button" className={styles.rcRetryBtn} onClick={() => void reload()}>
                重试
              </button>
            </div>
          )}

          <RcGroupRow hue="editor" icon="👁️" label="能力上限" desc="对方最高能申请到的档" off={off}
            detailTitle="能力上限"
            detail={
              <>
                <p>「可控」包含只看。对方申请的能力不能超过这里选的档。</p>
                <p>仅限<b>已配对</b>设备；默认每次远程都要你在本机点同意，可对单台设备开「免确认」跳过。</p>
                <p>远程 shell / 文件管理<b>不做</b>。</p>
              </>
            }
          >
            <div className={shared.sSegGroup}>
              <button
                type="button"
                className={`${shared.sSegText}${status.capability === "view" ? ` ${shared.sSegActive}` : ""}`}
                disabled={busy}
                aria-pressed={status.capability === "view"}
                onClick={() => void rc.setCapability("view")}
              >
                只看
              </button>
              <button
                type="button"
                className={`${shared.sSegText}${rcCanControl(status.capability) ? ` ${shared.sSegActive}` : ""}`}
                disabled={busy}
                aria-pressed={rcCanControl(status.capability)}
                title="包含只看"
                onClick={() => void rc.setCapability("control")}
              >
                可控
              </button>
            </div>
          </RcGroupRow>

          <RcGroupRow hue="capture" icon="🎬" label="画质档" desc="被控端编码档位，默认按链路自动换挡" off={off}
            detailTitle="画质档（被控端编码）"
            detail={
              <>
                <p>
                  {capsUnknown
                    ? "未能读取本机能力，已隐藏高帧率+/4K60 档——这是读取失败，不是本机不支持。"
                    : "默认「自动」：会话中按延迟与带宽在 流畅/均衡/清晰/超清 间自动切换；选其它档即锁定。"}
                </p>
                <p>
                  {status.quality === "auto"
                    ? status.session?.phase === "inbound_active"
                      ? `当前生效：${qualityLabel(status.active_quality ?? "balanced")}`
                      : "有人连进来后：从「均衡」起跑，再按链路自动升降档"
                    : "已锁定实名档：会话中不再自动换档。"}
                </p>
                <p>高帧率 / 4K60 档需本机硬件编码器，能力不足时不出现在菜单里。</p>
              </>
            }
          >
            <RcDropdown
              label="画质"
              // RcStatus 里这两项是宽 `string`（后端直传），与会话条同款收口成档位联合类型
              value={status.quality as RcQuality}
              options={qualities}
              columns={2}
              disabled={busy}
              disabledTitle={off ? "远程协助已关闭" : undefined}
              onPick={(k) => void rc.setQuality(k)}
            />
          </RcGroupRow>

          <RcGroupRow hue="system" icon="🖥️" label="画面范围"
            desc={monitorsUnknown ? "未能读取本机显示器列表，已隐藏逐屏选项" : `本机 ${monitors?.length ?? 0} 块屏`}
            off={off}
            detailTitle="画面范围"
            detail={
              <>
                <p>整个虚拟屏含副屏拼接；逐屏只推那一块，带宽最省。</p>
                <p>这里配的是<b>本机作为被控端</b>时对方能看到哪一块屏。</p>
              </>
            }
          >
            <RcDropdown
              label="画面"
              value={status.capture_scope as RcCaptureScope}
              options={scopeOptions(monitors ?? [])}
              columns={1}
              disabled={busy}
              disabledTitle={off ? "远程协助已关闭" : undefined}
              onPick={(k) => void rc.setCaptureScope(k)}
            />
          </RcGroupRow>
        </>
      )}
    </>
  );
}
