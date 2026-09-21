/**
 * RcWorkbench — A2 设备优先工作台。
 *
 * 空闲时设备侧栏是唯一导航真源；文件页复用同一选择，避免再画一套设备列表。
 * 会话态由 `resolveRcA2Surface` 强制置顶，不能被设置或历史页遮住。
 */
import { useEffect, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { useToast } from "@/components/Toast";
import { RcPairLayer, type RcPairLayerMode } from "@/components/settings/RcPairLayer";
import { useRc } from "@/hooks/useRc";
import { useRcAdhoc } from "@/hooks/useRcAdhoc";
import { useRcLaunch } from "@/hooks/useRcLaunch";
import { useRcWorkbenchClose } from "@/hooks/useRcWorkbenchClose";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDeviceRename } from "@/lib/api/rc";
import { readAutoStartChannel } from "@/lib/rcPrefs";
import { capabilityLabel } from "@/lib/rcRequest";
import { isSessionActive, workbenchMainMode } from "@/lib/rcWorkbench";
import { resolveRcA2Selection, resolveRcA2Surface, type RcA2Page } from "@/lib/rcWorkbenchA2";
import { RcA2DeviceDetail } from "./RcA2DeviceDetail";
import { RcA2Sidebar } from "./RcA2Sidebar";
import { RcA2TitleBar } from "./RcA2TitleBar";
import { RcErrorPanel } from "./RcErrorPanel";
import { RcPageFiles } from "./RcPageFiles";
import { RcPageHistory } from "./RcPageHistory";
import { RcPageSettings } from "./RcPageSettings";
import { RcStage } from "./RcStage";
import styles from "./RemoteComputerA2.module.css";

export function RcWorkbench() {
  const { toast } = useToast();
  const rc = useRc(true);
  const { cap, setDefaultCap, lastPeer, lastAttempt, doRequest, forgetDevice } = useRcLaunch(rc, toast);
  const [overlay, setOverlay] = useState<RcPairLayerMode>(null);
  const [page, setPage] = useState<RcA2Page>("devices");
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [autoStartDone, setAutoStartDone] = useState(false);

  useEffect(() => {
    void rc.refresh();
    void rc.refreshIdentity();
    void (async () => {
      // 🔴 2026-09-21：打开页面**只刷新列表，不再自动探活**。
      // 旧实现这里跟着跑一次全量探测，后果有两个：
      // ① 打开页面即发起一轮并发拨号（上限 8 台 × 3s 超时），慢且没必要；
      // ② 配合当时的「探测成功就写 last_seen」，「打开页面」会把所有能拨通的
      //    设备集体续命——表现就是「一打开，几个设备的在线状态全变了」。
      // 列表状态由 presence 四档如实展示；真要确认某台可达，用户点它时再探。
      await rc.refreshTargets();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mode = workbenchMainMode(rc.status);
  const surface = resolveRcA2Surface(mode, page);
  const session = rc.status?.session ?? null;
  const channelUp = rc.status?.running ?? false;
  const hasLiveSession = isSessionActive(rc.status);
  const selectedId = resolveRcA2Selection(rc.targets, selectedPeer ?? lastPeer);
  const selectedTarget = rc.targets.find((target) => target.node_id === selectedId) ?? null;

  useEffect(() => {
    if (autoStartDone) return;
    if (rc.status === null && rc.error === null) return;
    setAutoStartDone(true);
    if (readAutoStartChannel() && !channelUp) {
      void rc.startChannel().then((ok) => {
        if (!ok) toast("远程通道自动启动失败，可点顶部“启动远程通道”重试", "error");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartDone, channelUp]);

  useRcWorkbenchClose(hasLiveSession, rc.end);
  useRcAdhoc(rc);

  const openMainWindowSettings = () => {
    void emitTo("main", "pp:open-settings-rc").catch(() => {
      toast("跳转设置失败：主窗口不可达", "error");
    });
  };
  const startChannel = () => {
    void rc.startChannel().then((ok) => {
      if (ok) toast("远程通道已启动", "success");
    });
  };
  // 用户主动点「刷新」= 明确要求重探这一批，这里探全量是**对的**——
  // 与「打开页面自动探」的区别就在于是不是用户的意思（2026-09-21）。
  const probe = () => {
    setProbing(true);
    const all = rc.targets.map((t) => t.node_id);
    void rc.probeTargets(all).finally(() => setProbing(false));
  };
  const openFiles = (id: string) => {
    setSelectedPeer(id);
    setPage("files");
  };

  const inbound = mode === "inbound";
  const pending = mode === "pending";
  const lockedLabel = inbound ? "对方正在远程本机" : pending ? "已有申请在等对方同意" : "远程会话进行中";
  const sessionLabel = !session
    ? ""
    : inbound
      ? "对方正在远程本机"
      : pending
        ? "等待对方同意接入"
        : `正在远程控制 ${session.peer_name || fingerprintOf(session.peer)} · ${capabilityLabel(session.capability)}`;

  const stage = (
    <RcStage
      rc={rc}
      cap={cap}
      lastAttempt={lastAttempt}
      doRequest={doRequest}
      onPair={() => setOverlay("pair")}
      onHelpMe={() => setOverlay("helpMe")}
      onHelpOther={() => setOverlay("helpOther")}
      onUnoJoin={() => setOverlay("unoJoin")}
    />
  );

  const content =
    surface === "pending" || surface === "inbound" ? (
      stage
    ) : surface === "files" ? (
      <RcPageFiles rc={rc} selectedPeer={selectedId} onSelectPeer={setSelectedPeer} showTargetPicker={false} />
    ) : surface === "history" ? (
      <RcPageHistory rc={rc} onReconnect={(id, _name, c) => void doRequest(id, c)} />
    ) : surface === "settings" ? (
      <RcPageSettings
        rc={rc}
        cap={cap}
        toast={toast}
        onSetDefaultCap={setDefaultCap}
        onOpenSettings={openMainWindowSettings}
        onNavigateHistory={() => setPage("history")}
        onNavigateDevices={() => setPage("devices")}
      />
    ) : (
      <RcA2DeviceDetail
        target={selectedTarget}
        busy={rc.busy}
        locked={hasLiveSession}
        onConnect={(id, capability) => void doRequest(id, capability)}
        onSendFiles={openFiles}
        onPair={() => setOverlay("pair")}
        onSetAllowed={(id, allowed) => rc.setDeviceAllowed(id, allowed)}
        onSetTrust={(id, trusted) => rc.setDeviceTrust(id, trusted)}
        onSetAutoAccept={(id, enabled) => rc.setDeviceAutoAccept(id, enabled)}
        onForget={forgetDevice}
        onRename={async (id, note) => {
          try {
            await rcDeviceRename(id, note);
            await rc.refreshTargets();
            return true;
          } catch (error) {
            toast(String(error), "error");
            return false;
          }
        }}
        toast={toast}
      />
    );

  return (
    <div className={styles.workbench} data-rc-root="">
      <RcA2TitleBar
        channelUp={channelUp}
        busy={rc.busy}
        probing={probing}
        sessionLabel={sessionLabel}
        onProbe={probe}
        onStartChannel={startChannel}
      />

      {surface === "session" ? (
        <div className={styles.sessionSurface}>{stage}</div>
      ) : (
        <div className={styles.workbenchBody}>
          <RcA2Sidebar
            page={page}
            targets={rc.targets}
            selectedId={selectedId}
            busy={rc.busy}
            locked={hasLiveSession}
            lockedLabel={lockedLabel}
            onSelect={setSelectedPeer}
            onConnect={(id, capability) => void doRequest(id, capability)}
            onPair={() => setOverlay("pair")}
            onNavigate={setPage}
            selfEnabled={rc.status?.enabled ?? false}
            onToggleSelf={(enabled) => void rc.setEnabled(enabled)}
            onHelpMe={() => setOverlay("helpMe")}
            onHelpOther={() => setOverlay("helpOther")}
            onUnoJoin={() => setOverlay("unoJoin")}
          />
          <div className={styles.mainColumn}>
            {rc.error && (
              <div className={styles.errorSlot} role="status">
                <RcErrorPanel
                  error={rc.error}
                  onRetry={rc.isOpError ? undefined : () => void rc.refresh()}
                  onDismiss={rc.clearError}
                />
              </div>
            )}
            <div className={styles.mainSurface}>{content}</div>
          </div>
        </div>
      )}

      <RcPairLayer
        rc={rc}
        toast={toast}
        mode={overlay}
        onClose={() => setOverlay(null)}
        onStartRemote={(peerId) => void doRequest(peerId, cap)}
      />
    </div>
  );
}
