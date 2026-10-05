import { useCallback, useEffect, useState, type ReactNode } from "react";
import { KeyRound, Monitor, Plus, ScanLine, ShieldCheck } from "lucide-react";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { RcDeviceList } from "./RcDeviceList";
import { RcDeviceActions } from "./RcDeviceActions";
import { RcPairCard } from "./RcPairCard";
import { RcUnoJoinCard } from "./RcUnoJoinCard";
import { RcInboundAskCard } from "./RcInboundAskCard";
import { rcErrorText } from "./rcErrorText";
import { MobilePage } from "../ui/MobilePage";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import { MobileToast } from "../ui/MobileToast";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcDevices.module.css";

export function RcDevicesView({
  rc,
  session,
  onSendFiles,
  active = true,
  onErrorScopeChange,
  pageNotice,
}: {
  rc: UseRc;
  session: RcSession | null;
  onSendFiles: (nodeId: string) => void;
  active?: boolean;
  onErrorScopeChange?: (owned: boolean) => void;
  pageNotice?: ReactNode;
}) {
  const [pairing, setPairing] = useState(false);
  const [unoJoin, setUnoJoin] = useState<{ fixedTarget: string | null } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const targets = rc.targets ?? [];
  const pending = session?.phase === "outbound_pending" ? session : null;
  // 入站申请的确认卡（2026-10-02）：只有 App 开着就一定看得到。同屏来多条时
  // 全部列出——后到的可能是另一台电脑，不能只露出最新那条就把人堵死。
  const inbound = (rc.status?.pending ?? []).filter(
    () => !session || session.phase !== "outbound_active",
  );
  const pickedTarget = targets.find((target) => target.node_id === picked);
  const dismissNotice = useCallback(() => setNotice(""), []);
  const ownsError = active && (!!pickedTarget || !!unoJoin);
  useEffect(() => {
    onErrorScopeChange?.(ownsError);
    return () => onErrorScopeChange?.(false);
  }, [ownsError, onErrorScopeChange]);
  const probeTargets = rc.probeTargets;
  // 探测失败不得静默（规则 15.3）：静默的后果是设备点永远停在「检查中」，
  // 用户把「不可用」当成「离线」。失败转成一条可重试的提醒。
  const [probeError, setProbeError] = useState(false);
  const probe = useCallback(() => {
    setProbeError(false);
    void probeTargets().catch(() => setProbeError(true));
  }, [probeTargets]);
  useEffect(() => {
    if (active && rc.targetsLoaded && targets.length > 0) probe();
    // Pages stay mounted for paging; probe on entering, never for an offscreen preview.
  }, [active, rc.targetsLoaded, targets.length, probe]);
  return (
    <MobilePage
      title="设备"
      pageNotice={pageNotice}
      subtitle="连接电脑，让工作随身。"
      action={
        <button className={ui.textButton} onClick={() => setPairing(true)}>
          <Plus size={20} aria-hidden="true" />
          添加
        </button>
      }
    >
      {rc.targetsError && (
        <MobileNotice
          error
          title="设备列表未能更新"
          detail={rcErrorText(rc.targetsError)}
          action={
            <button className={ui.textButton} onClick={() => void rc.refreshTargets()}>
              重试
            </button>
          }
        />
      )}
      {active && notice && <MobileToast tone="success" title={notice} onDismiss={dismissNotice} />}
      {probeError && targets.length > 0 && (
        <MobileNotice tone="warning" title="在线状态检查失败"
          detail="设备的可用性可能不是最新，可重新检查。"
          action={<button className={ui.textButton} onClick={probe}>重新检查</button>} />
      )}
      {inbound.map((k) => (
        <RcInboundAskCard
          key={k.peer}
          knock={k}
          busy={rc.busy}
          onDeny={rc.deny}
        />
      ))}
      {session?.phase === "inbound_active" && (
        <MobileNotice tone="warning" title="这台手机无法提供远程画面或控制" detail="这是旧版本建立的连接，请结束后改为从手机连接电脑。"
          action={<button className={ui.secondary} disabled={rc.busy} onClick={() => void rc.end()}>
            {rc.busy ? "正在结束…" : "结束连接"}
          </button>} />
      )}
      {pending && (
        <MobileNotice tone="pending" title={`正在连接 ${pending.display_name || pending.peer_name}…`} detail="等待电脑端确认，受信任设备将自动通过。"
          action={<button className={ui.secondary} disabled={rc.busy} onClick={() => void rc.cancel()}>
            取消连接
          </button>} />
      )}
      <div className={styles.channel}>
        <div>
          <strong>
            {rc.status?.running
              ? "远程通道已开启"
              : rc.status?.enabled === false
                ? "远程通道已关闭"
                : rc.status
                  ? "远程通道尚未启动"
                  : "正在检查远程通道…"}
          </strong>
          <p>{targets.length} 台已配对设备</p>
        </div>
        <span>
          <ShieldCheck size={22} aria-hidden="true" />
        </span>
      </div>
      <div className={styles.actionsRow}>
        <button className={ui.secondary} onClick={() => setPairing(true)}>
          <ScanLine size={19} aria-hidden="true" />
          添加电脑
        </button>
        <button className={ui.secondary} onClick={() => setUnoJoin({ fixedTarget: null })}>
          <KeyRound size={19} aria-hidden="true" />
          无人值守
        </button>
      </div>
      <div className={ui.sectionHead}>
        <span>已配对设备</span>
        <button
          className={ui.textButton}
          disabled={rc.busy}
          onClick={() => {
            void rc.refreshTargets();
            probe();
          }}
        >
          重新检查
        </button>
      </div>
      {targets.length > 0 ? (
        <>
          <div className={ui.group}>
            <RcDeviceList
              targets={targets}
              reachability={rc.reachability}
              channelUp={rc.status?.running ?? null}
              onPick={setPicked}
            />
          </div>
          <p className={ui.hint}>点设备选择远程控制、观看或传文件。</p>
        </>
      ) : (
        <div className={ui.empty}>
          <Monitor aria-hidden="true" />
          <h2>{rc.targetsLoaded ? "还没有配对的电脑" : "正在获取设备…"}</h2>
          <p>
            在电脑端打开远程电脑，
            <br />
            扫码或输入配对码，即可开始。
          </p>
          {rc.targetsLoaded && (
            <button className={ui.primary} onClick={() => setPairing(true)}>
              添加第一台电脑
            </button>
          )}
        </div>
      )}
      <MobileSheet open={active && pairing} title="添加电脑" onClose={() => setPairing(false)}>
        {active && pairing && (
          <RcPairCard
            onPaired={(name) => {
              void rc.refreshTargets();
              setPairing(false);
              setNotice(`已与「${name}」配对。`);
            }}
          />
        )}
      </MobileSheet>
      <MobileSheet open={active && !!unoJoin} title="无人值守接入" onClose={() => setUnoJoin(null)}>
        {active && unoJoin && (
          <RcUnoJoinCard
            rc={rc}
            fixedTarget={unoJoin.fixedTarget}
            onClose={() => setUnoJoin(null)}
            onConnected={() => setUnoJoin(null)}
          />
        )}
      </MobileSheet>
      <MobileSheet open={active && !!pickedTarget} title="设备操作" onClose={() => setPicked(null)}>
        {active && pickedTarget && (
          <RcDeviceActions
            rc={rc}
            target={pickedTarget}
            onClose={() => setPicked(null)}
            onSendFiles={() => {
              onSendFiles(pickedTarget.node_id);
              setPicked(null);
            }}
            onUno={() => {
              setUnoJoin({ fixedTarget: pickedTarget.node_id });
              setPicked(null);
            }}
          />
        )}
      </MobileSheet>
    </MobilePage>
  );
}
