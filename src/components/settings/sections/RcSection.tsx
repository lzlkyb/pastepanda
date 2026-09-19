/**
 * RcSection — 设置页「远程电脑」分区（方案 A）。
 *
 * 配对独立于知识库同步：有自己的邀请码流程，写 rc_devices。
 * 主开关打开时自建远程通道，不依赖 kb_sync_enabled。
 */
import { useEffect, useState } from "react";
import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { useRc } from "@/hooks/useRc";
import { rcSetEnabled } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import { ToggleRow } from "../ToggleRow";
import { RcAllowPanel } from "../RcAllowPanel";
import { DEFAULT_RC_DEVICE_NAME } from "@/lib/rcDevice"; // C4：与 RcOverlay 统一默认设备名来源
import { rememberRequestCap } from "@/lib/rcRequest";
import { RcPairLayer, type RcPairLayerMode } from "../RcPairLayer";
import { RcSessionHistory } from "@/components/rc/RcSessionHistory";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";

interface RcSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

export function RcSection({ config, updateAndSave }: RcSectionProps) {
  const { toast } = useToast();
  const enabled = config.rc_enabled ?? false;
  const rc = useRc(true);
  /** 当前开着的弹层（长期配对 / 让别人帮我 / 帮别人连一次）——见 RcPairLayer。 */
  const [overlay, setOverlay] = useState<RcPairLayerMode>(null);

  useEffect(() => {
    void rc.refresh();
    void rc.refreshTargets();
    void rc.refreshIdentity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const joins = rc.status?.joins ?? [];

  return (
    <>
      <div className={shared.sSection}>远程电脑</div>
      <ToggleRow
        icon="🖥️"
        hue="sync"
        label="允许被远程协助"
        desc="独立于知识库同步：配对后对方可申请查看或控制这台电脑；默认关闭"
        value={enabled}
        detailTitle="允许被远程协助"
        detail={
          <>
            <p>远程配对与同步配对是两套授权，互不影响。</p>
            <p>🔒 会话制：申请 → 你确认 → 常驻横幅可随时结束</p>
            <p>⚠️ 不做远程 shell / 文件管理；无人值守只限一次性接入码（码会过期、可撤销）</p>
          </>
        }
        onChange={async (v) => {
          await updateAndSave({ rc_enabled: v });
          try {
            await rcSetEnabled(v);
            toast(v ? "已允许被远程协助" : "已关闭远程协助", "success");
            void rc.refresh();
          } catch (e) {
            logger.warn("切换远程协助失败", e);
            await updateAndSave({ rc_enabled: !v });
            toast(`远程协助切换失败：${e instanceof Error ? e.message : String(e)}`, "error");
          }
        }}
      />

      {/* 配对入口：方案 A —— 发起远程不依赖「允许被远程」，始终可见 */}
      <div className={shared.lanPanel}>
        <div className={styles.rcFpLine}>
          本机指纹 <span className={styles.rcFpValue}>{rc.identity?.fingerprint ?? "读取中…"}</span>
          <br />
          远程配对与知识库同步配对<b>分开</b>：这里只授权远程，不同步笔记。
          <br />
          发起远程<b>不需要</b>打开「允许被远程协助」。
        </div>
        <button
          type="button"
          className={`${shared.lanTestBtn} ${styles.rcFullBtn}`}
          disabled={!rc.identity}
          onClick={() => setOverlay("pair")}
        >
          ＋ 远程配对设备
        </button>

        {/* 方案甲：一次性协助。排在长期配对**下面**是因为这里是设置页——
            用户来设置页是为了把东西配好（长期），一次性那条路主入口在工作台。 */}
        <div className={styles.rcJoinBlock}>
          <div className={styles.rcJoinTitle}>一次性协助（不用配对）</div>
          <div className={styles.rcHint}>
            用完即弃：结束后不会留在双方的设备列表里。对方仍会收到确认，你也可以随时结束。
          </div>
          <button
            type="button"
            className={`${shared.lanTestBtn} ${styles.rcFullBtn}`}
            onClick={() => setOverlay("helpMe")}
          >
            让别人帮我（出码给对方）
          </button>
          <button
            type="button"
            className={`${shared.lanTestBtn} ${styles.rcFullBtn}`}
            onClick={() => setOverlay("helpOther")}
          >
            帮别人连一次（粘对方的码）
          </button>
        </div>

        {/* Q2 方案 B：无人值守接入。放在一次性协助之后——它也是「不用现场点头」，
            但语义是「对面压根没人」：码就是授权，靠时效与可撤销兜安全。 */}
        <div className={styles.rcJoinBlock}>
          <div className={styles.rcJoinTitle}>无人值守接入码</div>
          <div className={styles.rcHint}>
            对方不在电脑前也能连：生成一次性接入码（默认 15 分钟 · 限 1 次，不落盘、可撤销），
            对方粘贴后自动配对连入，接入全程有横幅、有记录。
          </div>
          {(rc.status?.uno?.length ?? 0) > 0 && (
            <div className={styles.rcHint}>
              ⏳ 有 {rc.status?.uno?.length} 个接入码生效中
              （最近一个 {(() => {
                const exp = Math.max(...(rc.status?.uno ?? []).map((u) => u.expires_ms));
                const left = Math.max(0, exp - Date.now());
                return left >= 3600_000
                  ? `${Math.floor(left / 3600_000)} 小时后过期`
                  : `${Math.max(1, Math.floor(left / 60_000))} 分钟后过期`;
              })()}）
              <button
                type="button"
                className={shared.lanRefreshBtn}
                style={{ marginLeft: 8 }}
                disabled={rc.busy}
                onClick={() => {
                  void rc.unoRevoke().then((ok) => {
                    if (ok) toast("已撤销全部接入码", "info");
                  });
                }}
              >
                撤销全部
              </button>
            </div>
          )}
          <button
            type="button"
            className={`${shared.lanTestBtn} ${styles.rcFullBtn}`}
            disabled={!enabled}
            onClick={() => setOverlay("unoGenerate")}
          >
            生成无人值守接入码
          </button>
          <button
            type="button"
            className={`${shared.lanTestBtn} ${styles.rcFullBtn}`}
            onClick={() => setOverlay("unoJoin")}
          >
            我有对方的接入码
          </button>
        </div>

        {joins.length > 0 && (
          <div className={styles.rcJoinBlock}>
            <div className={styles.rcJoinTitle}>
              🔔 有 {joins.length} 台设备想完成远程配对
            </div>
            {joins.map((j) => (
              <div key={j.node_id} className={`${shared.lanDeviceItem} ${styles.rcJoinRow}`}>
                <div className={shared.lanDeviceInfo}>
                  <div className={shared.lanDeviceTime}>指纹 {fingerprintOf(j.node_id)}</div>
                </div>
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
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 主开关关时仍渲染能力/设备面板（变灰），避免整块消失导致用户不知道有哪些档可配（规则 15.2） */}
      {rc.status && (
        <RcAllowPanel rc={rc} status={rc.status} targets={rc.targets} />
      )}
      <div className={styles.rcBlockTop}>
        <div className={styles.rcSubTitle}>最近会话</div>
        <RcSessionHistory
          targets={rc.targets}
          running={!!rc.status?.running}
          busy={rc.busy}
          onReconnect={(id, name, cap) => {
            // 沿用这条记录用过的档，并记为下次的默认档——与设备列表「沿用上次」同一语义
            rememberRequestCap(cap);
            void rc.request(id, cap).then((ok) => {
              if (ok) toast(`已向「${name}」再次发起远程申请`, "success");
            });
          }}
        />
      </div>
      {rc.error && <div className={styles.rcErrLine}>{rc.error}</div>}

      {/*
        🔴 这里**不传** `onStartRemote`：设置页没有会话上下文（发起链路的
        撤销窗口与能力档记忆都在工作台）。RcAdhocDialog 会退回 `rc.request`
        直发「只看」——不是漏传，刻意如此。
      */}
      <RcPairLayer rc={rc} toast={toast} mode={overlay} onClose={() => setOverlay(null)} />
    </>
  );
}
