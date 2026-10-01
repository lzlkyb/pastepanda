/**
 * RcPairGroup — 组 1「谁能连进来」。
 *
 * 收的是**授权入口**：长期配对、一次性帮助、待确认请求、逐台限制。
 * 判据放在编排层（`RcSection`）：组收起时这里的行根本不渲染，所以
 * 「有待确认请求 ⇒ 自动展开」只能由拿着 `rc.status` 的父级决定。
 *
 * 摘要里的三个计数全部来自真值（`targets` / `joins`），禁止写死数字：
 * 收起态它是用户看清现状的唯一来源，错一个就是骗人（设计稿 §6 守卫 ③）。
 *
 * 🔴 本组**一处都不吃「允许被远程协助」**：配对、出码、粘码、待确认的允许/拒绝在
 * 主开关关掉时照样可用（HEAD 的 `disabled` 只挂 `rc.identity` / `rc.busy`，这是
 * 「发起远程不需要被远程授权」这条不变量的落点）。只有下面的逐台限制子表按
 * `status.enabled` 变灰——那才是真「被控」配置。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import { DEFAULT_RC_DEVICE_NAME } from "@/lib/rcDevice";
import type { UseRc } from "@/hooks/useRc";
import type { RcStatus, RcTargetDevice } from "@/lib/api/rc";
import { useToast } from "@/components/Toast";
import type { RcPairLayerMode } from "../RcPairLayer";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";
import { RcGroupHead } from "./RcGroupHead";
import { RcGroupRow } from "./RcGroupRow";
import { RcDeviceRestrictList } from "./RcDeviceRestrictList";

export function RcPairGroup({
  rc,
  status,
  targets,
  joins,
  open,
  inert,
  devOpen,
  onToggle,
  onToggleDev,
  onOverlay,
}: {
  rc: UseRc;
  status: RcStatus | null;
  targets: RcTargetDevice[];
  joins: NonNullable<RcStatus["joins"]>;
  open: boolean;
  /** 搜索态：组头停止响应点击（判据与强制展开同源，见 `RcGroupHead`）。 */
  inert?: boolean;
  /** 子表自己的开合位（与组的开合是两个独立位，见 RcDeviceRestrictList 注释） */
  devOpen: boolean;
  onToggle: () => void;
  onToggleDev: () => void;
  onOverlay: (mode: RcPairLayerMode) => void;
}) {
  const { toast } = useToast();
  const trustedCount = targets.filter((d) => d.trusted).length;
  const deniedCount = targets.filter(
    (d) => (status?.device_deny[d.node_id] ?? d.denied) === true,
  ).length;

  return (
    <>
      <RcGroupHead
        label="谁能连进来"
        open={open}
        inert={inert}
        onToggle={onToggle}
        summary={
          /* 🔴 摘要在收起态是用户看清现状的**唯一**来源，所以「还没读到」必须说成
             「读取中…」，不能报 0——报 0 是断言「一台都没有」，而此刻根本没有证据。
             （平铺版没这个问题：面板整块在数据回来后才出现。）
             三态判据与主窗设备列表一致：读失败 ≠ 还在读，也别报 0。 */
          status === null || !rc.targetsLoaded ? (
            <>{rc.targetsError ? "设备列表读取失败" : "读取中…"}</>
          ) : (
            <>
              已配对<span className={styles.rcGroupCount}>{targets.length}</span> · 待确认
              <span className={styles.rcGroupCount}>{joins.length}</span> · 免确认
              <span className={styles.rcGroupCount}>{trustedCount}</span> · 指纹{" "}
              <span className={styles.rcFpValue}>
                {rc.identity?.fingerprint ?? "读取中…"}
              </span>
            </>
          )
        }
      />
      {open && (
        <>
          <RcGroupRow
            hue="sync"
            icon="🔗"
            label="远程配对设备"
            desc="生成邀请码给对方，连完默认保留配对"
            detailTitle="远程配对设备"
            detail={
              <>
                <p>长期配对：对方粘你的邀请码，连完默认保留在设备列表。</p>
                <p>远程配对与知识库同步配对是<b>两套授权</b>，互不影响。</p>
                <p>发起远程<b>不需要</b>打开「允许被远程协助」。</p>
              </>
            }
          >
            {/* 只等身份读回来（邀请码要带 node_id）；**不吃主开关**——配对是出站前置动作 */}
            <button
              type="button"
              className={shared.lanRefreshBtn}
              disabled={!rc.identity}
              onClick={() => onOverlay("pair")}
            >
              配对
            </button>
          </RcGroupRow>

          <RcGroupRow
            hue="capture"
            icon="🤝"
            label="一次性帮助"
            desc="双方都在场：我出码给对方帮 / 粘对方的码去帮"
            detailTitle="一次性帮助（不用配对）"
            detail={
              <>
                <p>双方都在场：一方出码、一方粘码。</p>
                <p>码用完即弃，对方仍会收到确认，你也可以随时结束。</p>
                <p>这次之后对方会<b>默认留在设备列表里</b>，不想留随时在列表删。</p>
              </>
            }
          >
            {/* 与「允许被远程」无关的两条出站路：帮人 = 我发起；被帮 = 对方发起、我点头。
                HEAD 在这里就没有 disabled，别把它当成「漏了」补上。 */}
            <span className={styles.rcBtnRow}>
              <button type="button" className={shared.lanRefreshBtn} onClick={() => onOverlay("helpMe")}>
                我出码
              </button>
              <button type="button" className={shared.lanRefreshBtn} onClick={() => onOverlay("helpOther")}>
                粘码
              </button>
            </span>
          </RcGroupRow>

          {joins.map((j) => (
            <RcGroupRow
              key={j.node_id}
              hue="privacy"
              icon="🔔"
              label="待确认请求"
              desc={
                <>
                  1 台设备想用指纹 <span className={styles.rcFpValue}>{fingerprintOf(j.node_id)}</span> 完成配对
                </>
              }
            >
              <span className={styles.rcBtnRow}>
                <button
                  type="button"
                  className={shared.lanRefreshBtn}
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
                  className={shared.lanRefreshBtn}
                  disabled={rc.busy}
                  onClick={() => {
                    void rc.approveJoin(j.node_id, DEFAULT_RC_DEVICE_NAME).then((ok) => {
                      if (ok) toast("已允许远程配对", "success");
                    });
                  }}
                >
                  允许
                </button>
              </span>
            </RcGroupRow>
          ))}

          <RcGroupRow
            hue="system"
            icon="💻"
            label="已配对设备"
            desc={
              targets.length === 0
                ? "还没有配对设备"
                : `免确认 ${trustedCount} 台 · 已禁止 ${deniedCount} 台；点开逐台改`
            }
            detailTitle="已配对设备"
            detail={
              <>
                <p>与「暂停同步」是<b>两个开关</b>：暂停停同步，这里停远程。</p>
                <p>「免确认」只对单台设备生效：开了之后它发起远程时不再逐次询问你。</p>
              </>
            }
          >
            {/* 展开是浏览动作，任何开关都不该锁它（§4 搜索态也要求这一行可见可点） */}
            <button type="button" className={shared.lanRefreshBtn} onClick={onToggleDev}>
              {devOpen ? "收起" : `展开 ${targets.length} 台`}
            </button>
          </RcGroupRow>

          {devOpen && status && <RcDeviceRestrictList rc={rc} status={status} targets={targets} />}
        </>
      )}
    </>
  );
}
