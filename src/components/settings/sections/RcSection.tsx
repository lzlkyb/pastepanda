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
import { RcPairDialog } from "../RcPairDialog";
import { RcSessionHistory } from "@/components/rc/RcSessionHistory";
import styles from "../../Settings.module.css";

interface RcSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

export function RcSection({ config, updateAndSave }: RcSectionProps) {
  const { toast } = useToast();
  const enabled = config.rc_enabled ?? false;
  const rc = useRc(true);
  const [pairOpen, setPairOpen] = useState(false);

  useEffect(() => {
    void rc.refresh();
    void rc.refreshTargets();
    void rc.refreshIdentity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const joins = rc.status?.joins ?? [];

  return (
    <>
      <div className={styles.sSection}>远程电脑</div>
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
            <p>⚠️ 不做远程 shell / 文件管理 / 无人值守</p>
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
      <div className={styles.lanPanel}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
          本机指纹{" "}
          <span
            style={{
              fontFamily: "ui-monospace, Consolas, monospace",
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            {rc.identity?.fingerprint ?? "读取中…"}
          </span>
          <br />
          远程配对与知识库同步配对<b>分开</b>：这里只授权远程，不同步笔记。
          <br />
          发起远程<b>不需要</b>打开「允许被远程协助」。
        </div>
        <button
          type="button"
          className={styles.lanTestBtn}
          style={{ width: "100%" }}
          disabled={!rc.identity}
          onClick={() => setPairOpen(true)}
        >
          ＋ 远程配对设备
        </button>

        {joins.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
              🔔 有 {joins.length} 台设备想完成远程配对
            </div>
            {joins.map((j) => (
              <div key={j.node_id} className={styles.lanDeviceItem} style={{ marginBottom: 6 }}>
                <div className={styles.lanDeviceInfo}>
                  <div className={styles.lanDeviceTime}>指纹 {fingerprintOf(j.node_id)}</div>
                </div>
                <button
                  type="button"
                  className={styles.lanRefreshBtn}
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
                  className={styles.lanRefreshBtn}
                  disabled={rc.busy}
                  onClick={() => {
                    void rc.approveJoin(j.node_id, "").then((ok) => {
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

      {enabled && (
        <>
          {rc.status && (
            <RcAllowPanel rc={rc} status={rc.status} targets={rc.targets} />
          )}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8 }}>最近会话</div>
            <RcSessionHistory />
          </div>
          {rc.error && (
            <div style={{ fontSize: 12, color: "var(--danger, #d64545)", marginTop: 8 }}>
              {rc.error}
            </div>
          )}
        </>
      )}
      {!enabled && rc.error && (
        <div style={{ fontSize: 12, color: "var(--danger, #d64545)", marginTop: 8 }}>
          {rc.error}
        </div>
      )}

      {pairOpen && (
        <RcPairDialog rc={rc} toast={toast} onClose={() => setPairOpen(false)} />
      )}
    </>
  );
}
