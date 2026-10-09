import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, KeyRound, Monitor, Plus } from "lucide-react";
import { rcDisplayName } from "@/lib/rcDevice";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { RcChannelNotice } from "./RcChannelNotice";
import { RcDeviceList } from "./RcDeviceList";
import { RcDeviceActions } from "./RcDeviceActions";
import { RcPairCard } from "./RcPairCard";
import { RcUnoJoinCard } from "./RcUnoJoinCard";
import { RcInboundAskCard } from "./RcInboundAskCard";
import { rcErrorText } from "./rcErrorText";
import { useMobileDeviceConnect } from "./useMobileDeviceConnect";
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
  const pairBack = useRef<(() => boolean) | null>(null);
  const deviceBack = useRef<(() => boolean) | null>(null);
  const unoBack = useRef<(() => boolean) | null>(null);
  const [pairing, setPairing] = useState(false);
  // 配对卡随面板关闭卸载；仅保留手输草稿，相机与会合请求仍在关闭时释放。
  const [pairDraft, setPairDraft] = useState("");
  const [unoJoin, setUnoJoin] = useState<{ fixedTarget: string | null } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const connection = useMobileDeviceConnect(rc, session);
  const targets = rc.targets ?? [];
  const connectionTarget = targets.find(target => target.node_id === connection.peer);
  const pending = session?.phase === "outbound_pending" ? session : null;
  // 入站申请的确认卡（2026-10-02）：只有 App 开着就一定看得到。同屏来多条时
  // 全部列出——后到的可能是另一台电脑，不能只露出最新那条就把人堵死。
  const inbound = (rc.status?.pending ?? []).filter(
    () => !session || session.phase !== "outbound_active",
  );
  const pickedTarget = targets.find((target) => target.node_id === picked);
  const dismissNotice = useCallback(() => setNotice(""), []);
  const ownsError = active && (!!pickedTarget || !!unoJoin || !!connection.peer);
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
    // 切页保留页面状态；只在进入设备页时探测，后台页不发请求。
  }, [active, rc.targetsLoaded, targets.length, probe]);
  return (
    <MobilePage
      title="设备"
      subtitle="连接电脑，让工作随身。"
      pageNotice={pageNotice}
      action={targets.length > 0 &&
        <button className={ui.textButton} onClick={() => setPairing(true)}>
          <Plus size={20} aria-hidden="true" />
          添加电脑
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
      {active && notice && <MobileToast placement="flow" tone="success" title={notice} onDismiss={dismissNotice} />}
      {active && connection.peer && !pickedTarget && !unoJoin && (connection.error || rc.error) && (
        <MobileNotice error title={`未能连接 ${rcDisplayName(connectionTarget ?? {}, "目标设备")}`} detail={connection.error || rcErrorText(rc.error)}
          onDismiss={connection.clearError}
          action={<button className={ui.textButton} disabled={connection.blocked || !connectionTarget} onClick={() => {
            if (connectionTarget) void connection.request(connectionTarget, "control");
          }}>重试</button>} />
      )}
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
        <MobileNotice tone="pending" title={`正在连接 ${rcDisplayName(pending, "电脑")}…`} detail="等待电脑端确认，受信任设备将自动通过。"
          action={<button className={ui.secondary} disabled={rc.busy} onClick={() => void rc.cancel()}>
            取消连接
          </button>} />
      )}
      <RcChannelNotice rc={rc} />
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
              onPick={id => {
                // 在途请求的错误先写全局槽再返回；此时换详情会把 A 的失败显示在 B 上。
                if (connection.working) return;
                // 进入另一个操作域前清除本页连接失败，避免把 A 的错误挂到 B 的详情。
                if (connection.error) connection.clearError();
                setPicked(id);
              }}
              onConnect={target => void connection.request(target, "control")}
              connectBlocked={connection.blocked}
              connectingPeer={connection.working?.peer}
              detailsBlocked={!!connection.working}
            />
          </div>
          <p className={ui.hint}>点「连接」控制电脑；点设备查看观看、文件和管理操作。在线状态未知时仍可尝试连接。</p>
        </>
      ) : (
        <div className={ui.empty}>
          <Monitor aria-hidden="true" />
          <h2>{rc.targetsError ? "暂时无法获取设备" : rc.targetsLoaded ? "还没有配对的电脑" : "正在获取设备…"}</h2>
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
      <div className={ui.sectionHead}>其他连接方式</div>
      <div className={ui.group}>
        <button className={styles.connectionEntry} disabled={rc.busy || !!connection.working} onClick={() => setUnoJoin({ fixedTarget: null })}>
          <KeyRound size={20} aria-hidden="true" /><span><strong>无人值守接入</strong><small>使用电脑提供的接入码或密码</small></span><ChevronRight size={18} aria-hidden="true" />
        </button>

      </div>
      <MobileSheet open={active && pairing} title="添加电脑" onBack={() => { if (!pairBack.current?.()) setPairing(false); }} onClose={() => setPairing(false)}>
        {active && pairing && (
          <RcPairCard
            backRef={pairBack}
            initialDraft={pairDraft}
            onDraftChange={setPairDraft}
            onPaired={(name) => {
              void rc.refreshTargets();
              setPairing(false);
              setPairDraft("");
              setNotice(`已与「${name}」配对。`);
            }}
          />
        )}
      </MobileSheet>
      <MobileSheet open={active && !!unoJoin} title="无人值守接入" onBack={() => { if (!unoBack.current?.()) setUnoJoin(null); }} onClose={() => setUnoJoin(null)}>
        {active && unoJoin && (
          <RcUnoJoinCard
            backRef={unoBack}
            rc={rc}
            fixedTarget={unoJoin.fixedTarget}
            onClose={() => setUnoJoin(null)}
            onConnected={() => setUnoJoin(null)}
          />
        )}
      </MobileSheet>
      <MobileSheet open={active && !!pickedTarget} title="设备操作" onBack={() => { if (!deviceBack.current?.()) setPicked(null); }} onClose={() => setPicked(null)}>
        {active && pickedTarget && (
          <RcDeviceActions
            backRef={deviceBack}
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
