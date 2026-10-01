/**
 * RcDevicesView — 设备页签内容：空态 / 列表态 / 配对卡 / pending 等待卡。
 *
 * 编排按设计稿 §1 三态 + §2/§3 状态机；数据全来自 useRc（rcStore），
 * 会话 active 态由 App 换屏（本组件只管 pending 卡）。错误条常驻页内
 * （规则 15.3：失败不靠 toast 一闪），文案说人话。
 */
import { useCallback, useEffect, useState } from "react";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { RcDeviceList } from "./RcDeviceList";
import { RcPairCard } from "./RcPairCard";
import { RcUnoJoinCard } from "./RcUnoJoinCard";
import styles from "./RcDevices.module.css";
import { rcErrorText } from "./rcErrorText";

export function RcDevicesView({
  rc,
  session,
  onSendFiles,
}: {
  rc: UseRc;
  /** status.session（App 传下）：outbound_pending → 本组件渲染等待卡。 */
  session: RcSession | null;
  /** 动作面板「传文件」→ App 切到文件页并预选这台设备。 */
  onSendFiles: (nodeId: string) => void;
}) {
  const [pairing, setPairing] = useState(false);
  /** 无人值守接入卡。fixedTarget 非空 = 从设备动作面板进来（已锁定对象）。 */
  const [unoJoin, setUnoJoin] = useState<{ fixedTarget: string | null } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const targets = rc.targets ?? [];
  const channelUp = rc.status?.running ?? null;

  // 列表落地后探一轮可达性（与桌面侧栏同源数据，手机上一次就够；下拉刷新再探）
  useEffect(() => {
    if (!rc.targetsLoaded || targets.length === 0) return;
    void rc.probeTargets().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rc.targetsLoaded, targets.length]);

  const pending = session?.phase === "outbound_pending" ? session : null;
  const pendingName = pending
    ? (targets.find((t) => t.node_id === pending.peer)?.display_name ?? pending.peer_name)
    : "";
  const pickedTarget = picked ? targets.find((t) => t.node_id === picked) : null;

  const request = useCallback(
    (capability: "control" | "view") => {
      if (!picked) return;
      void rc.request(picked, capability);
      setPicked(null); // 结果由 status.session 驱动：pending 卡 / active 换屏 / 错误条
    },
    [picked, rc],
  );

  const errText = rc.error ?? rc.targetsError;
  const errFriendly = errText ? rcErrorText(errText) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {errText && (
        <div className={styles.errBar} role="alert">
          <span className={styles.errBarText}>{errFriendly}</span>
          <button
            type="button"
            className={styles.errBtn}
            onClick={() => {
              rc.clearError();
              void rc.refreshTargets();
            }}
          >
            重试
          </button>
          <button type="button" className={styles.errBtn} onClick={rc.clearError}>
            ✕
          </button>
        </div>
      )}

      {pending ? (
        <div className={styles.pendingCard} role="status">
          <div>
            <span className={styles.spin} />
          </div>
          <div className={styles.pendingTitle}>正在连接 {pendingName || "对方"}…</div>
          <div className={styles.pendingSub}>等对方在电脑上确认（受信任设备将自动通过）</div>
          <button type="button" className={styles.ghostBtn} onClick={() => void rc.cancel()}>
            取消
          </button>
        </div>
      ) : unoJoin ? (
        <RcUnoJoinCard
          rc={rc}
          fixedTarget={unoJoin.fixedTarget}
          onClose={() => setUnoJoin(null)}
          onConnected={() => setUnoJoin(null)}
        />
      ) : pairing ? (
        <RcPairCard
          onClose={() => setPairing(false)}
          onPaired={() => {
            void rc.refreshTargets();
            window.setTimeout(() => setPairing(false), 1400);
          }}
        />
      ) : targets.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🖥</div>
          <div className={styles.emptyTitle}>
            {rc.targetsLoaded ? "还没有配对的电脑" : "正在获取设备…"}
          </div>
          <div className={styles.emptyHint}>
            和电脑互相输入对方的 8 位配对码，
            <br />
            一次配对，长期可用
          </div>
          <button type="button" className={styles.primaryBtn} onClick={() => setPairing(true)}>
            配对电脑
          </button>
        </div>
      ) : (
        <>
          <div className={styles.selfCard}>
            <div className={styles.deviceName}>
              <span className={`${styles.dot} ${styles.dotOk}`} aria-hidden="true" />
              {rc.identity?.device_name || "这台手机"}
              <span className={styles.selfTag}>本机</span>
            </div>
            {rc.identity?.fingerprint && (
              <div className={styles.deviceSub}>
                指纹 <span className={styles.fp}>{rc.identity.fingerprint.slice(-8)}</span>
              </div>
            )}
          </div>
          <RcDeviceList
            targets={targets}
            reachability={rc.reachability}
            channelUp={channelUp}
            onPick={setPicked}
          />
          <div className={styles.actionsRow}>
            <button type="button" className={styles.ghostBtn} onClick={() => setPairing(true)}>
              ＋ 配对新电脑
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => setUnoJoin({ fixedTarget: null })}
            >
              无人值守接入
            </button>
          </div>
        </>
      )}

      {pickedTarget && (
        <>
          <div className={styles.sheetBackdrop} onClick={() => setPicked(null)} />
          <div className={styles.sheet} role="dialog" aria-label={`连接 ${pickedTarget.display_name || pickedTarget.name}`}>
            <div className={styles.sheetTitle}>{pickedTarget.display_name || pickedTarget.name}</div>
            <button type="button" className={styles.sheetBtn} onClick={() => request("control")}>
              远程控制
            </button>
            <button type="button" className={`${styles.sheetBtn} ${styles.sheetBtnCyan}`} onClick={() => request("view")}>
              只看画面
            </button>
            <button
              type="button"
              className={styles.sheetBtn}
              onClick={() => {
                onSendFiles(pickedTarget.node_id);
                setPicked(null);
              }}
            >
              传文件
            </button>
            <button
              type="button"
              className={styles.sheetBtn}
              onClick={() => {
                setUnoJoin({ fixedTarget: pickedTarget.node_id });
                setPicked(null);
              }}
            >
              无人值守接入
            </button>
            <button
              type="button"
              className={`${styles.sheetBtn} ${styles.sheetBtnDanger}`}
              onClick={() => {
                if (!confirmForget) {
                  setConfirmForget(true);
                  return;
                }
                void rc.forget(pickedTarget.node_id).then(() => {
                  setConfirmForget(false);
                  setPicked(null);
                });
              }}
            >
              {confirmForget ? "再点一次确认解除" : "解除配对"}
            </button>
            <button
              type="button"
              className={`${styles.sheetBtn} ${styles.sheetBtnGhost}`}
              onClick={() => {
                setPicked(null);
                setConfirmForget(false);
              }}
            >
              取消
            </button>
          </div>
        </>
      )}
    </div>
  );
}
