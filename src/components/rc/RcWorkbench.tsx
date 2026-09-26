/**
 * RcWorkbench — A2 设备优先工作台。
 *
 * 空闲时设备侧栏是唯一导航真源；文件页复用同一选择，避免再画一套设备列表。
 * 会话态由 `resolveRcA2Surface` 强制置顶，不能被设置或历史页遮住。
 *
 * 批5：会话历史提到这一层（`useRcHistory`），因为三个消费点跨了侧栏与主区
 * ——① 记录页侧栏「按设备筛选」、② 详情面「最近会话」、③ 记录页列表。
 * 各自拉一次会让「全部 N 条」与各设备计数来自不同批快照，对不上账。
 */
import { useEffect, useMemo, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { useToast } from "@/components/Toast";
import { RcPairLayer, type RcPairLayerMode } from "@/components/settings/RcPairLayer";
import { useRc } from "@/hooks/useRc";
import { useRcAutoCheck } from "@/hooks/useRcAutoCheck";
import { useRcDeviceUi } from "@/hooks/useRcDeviceUi";
import { useRcHistory } from "@/hooks/useRcHistory";
import { useRcLaunch } from "@/hooks/useRcLaunch";
import { useRcRequestEndNotice } from "@/hooks/useRcRequestEndNotice";
import { useRcTransferNotice } from "@/hooks/useRcTransferNotice";
import { useRcWorkbenchClose } from "@/hooks/useRcWorkbenchClose";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { rcDeviceRename, rcDeviceRemarkSet, rcDeviceTagsSet } from "@/lib/api/rc";
import { normalizeHistoryPeer, summarizeHistoryDevices } from "@/lib/rcHistory";
import { readAutoStartChannel } from "@/lib/rcPrefs";
import { capabilityLabel } from "@/lib/rcRequest";
import { isSessionActive, workbenchMainMode } from "@/lib/rcWorkbench";
import { resolveRcA2Selection, resolveRcA2Surface, hidesWorkbenchTitleBar, type RcA2Page } from "@/lib/rcWorkbenchA2";
import { RcA2DeviceDetail } from "./RcA2DeviceDetail";
import { RcA2Sidebar } from "./RcA2Sidebar";
import { RcA2TitleBar } from "./RcA2TitleBar";
import { RcJoinRequests } from "./RcJoinRequests";
import { RcPageFiles } from "./RcPageFiles";
import { RcPageHistory } from "./RcPageHistory";
import { RcPageSettings } from "./RcPageSettings";
import { RcStage } from "./RcStage";
import { RcWorkbenchErrorSlot } from "./RcWorkbenchErrorSlot";
import styles from "./RemoteComputerA2.module.css";

export function RcWorkbench() {
  const { toast } = useToast();
  const rc = useRc(true);
  const { cap, capOf, setDefaultCap, lastPeer, lastAttempt, doRequest, forgetDevice } = useRcLaunch(rc, toast);
  const history = useRcHistory();
  // P3-7：改名草稿/管理展开挂在工作台层——详情面随切页卸载会丢草稿（规则 15.2）
  const deviceUi = useRcDeviceUi();
  const [overlay, setOverlay] = useState<RcPairLayerMode>(null);
  const [page, setPage] = useState<RcA2Page>("devices");
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [historyPeerRaw, setHistoryPeer] = useState<string | null>(null);
  const [autoStartDone, setAutoStartDone] = useState(false);
  // U10：设置页「管理免确认设备」跳进来时打开的过滤态
  const [trustedOnly, setTrustedOnly] = useState(false);
  // U2：传输的角标 / 摘要条 / 终态 toast（不在文件页时才报终态）
  const transfer = useRcTransferNotice(page, rc.targets, () => setPage("files"), toast);
  // U4：申请被拒/超时的当下反馈（不再静默跳回设备页）
  const session = rc.status?.session ?? null;
  useRcRequestEndNotice(session, rc.targets, history, toast);

  const historyDevices = useMemo(() => summarizeHistoryDevices(history.list), [history.list]);
  /* 传下去的永远是有效筛选值：设备被移除 / 记录被清空后退回「全部设备」，
     避免侧栏出现「一项都没选中」的空列表死角。state 本身保持原值。 */
  const historyPeer = normalizeHistoryPeer(historyPeerRaw, historyDevices);

  useEffect(() => {
    void rc.refresh();
    void rc.refreshIdentity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mode = workbenchMainMode(rc.status);
  const surface = resolveRcA2Surface(mode, page);
  const channelUp = rc.status?.running ?? false;
  const hasLiveSession = isSessionActive(rc.status);
  const refreshDeviceChecks = useRcAutoCheck({
    enabled: !hasLiveSession && page !== "history",
    channelUp,
    refreshTargets: rc.refreshTargets,
    probeTargets: rc.probeTargets,
  });
  const selectedId = resolveRcA2Selection(rc.targets, selectedPeer ?? lastPeer);
  const selectedTarget = rc.targets.find((target) => target.node_id === selectedId) ?? null;
  // 渲染期同步 UI 草稿归属（换设备才重置）；同组件 setState，与原详情面写法一致
  deviceUi.syncPeer(selectedId);

  useEffect(() => {
    if (autoStartDone) return;
    if (rc.status === null && rc.error === null) return;
    setAutoStartDone(true);
    if (readAutoStartChannel() && !channelUp) {
      void rc.startChannel().then((ok) => {
        // 批7：「启动远程通道」按钮已下架，改成标题栏中间的状态位（未启动时本身可点）
        if (!ok) toast("远程通道自动启动失败，可点顶部状态位「通道未启动 · 点击开启」重试", "error");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartDone, channelUp]);

  useRcWorkbenchClose(hasLiveSession, rc.end);

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
  const openFiles = (id: string) => {
    setSelectedPeer(id);
    setPage("files");
  };
  /* 改名/标签/备注三种保存同构（规则 11.1 收口）：命令→刷新→回布尔，报错走 toast。 */
  const saveDeviceField = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run(); await rc.refreshTargets();
      return true;
    } catch (error) { toast(String(error), "error"); return false; }
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
        : `正在远程控制 ${rcDisplayName(session, fingerprintOf(session.peer))} · ${capabilityLabel(session.capability)}`;

  const stage = (
    <RcStage
      rc={rc}
      capFor={capOf}
      lastAttempt={lastAttempt}
      doRequest={doRequest}
      onPair={() => setOverlay("pair")}
      onHelpMe={() => setOverlay("helpMe")}
      onHelpOther={() => setOverlay("helpOther")}
      onUnoJoin={() => setOverlay("unoJoin")}
    />
  );

  /* 🔴 2026-09-23：四态共用**同一个挂载 div**（旧写法 session 在另一棵树，
     pending→session 整棵 RcStage 重挂、解码器归零）。 */
  const onStage = surface === "session" || surface === "pending" || surface === "inbound";

  const content =
    surface === "files" ? (
      <RcPageFiles rc={rc} selectedPeer={selectedId} onSelectPeer={setSelectedPeer} showTargetPicker={false} />
    ) : surface === "history" ? (
      <RcPageHistory
        rc={rc}
        peer={historyPeer}
        history={history}
        onReconnect={(id, _name, c) => void doRequest(id, c)}
      />
    ) : surface === "settings" ? (
      <RcPageSettings
        rc={rc}
        cap={cap}
        toast={toast}
        onSetDefaultCap={setDefaultCap}
        onOpenSettings={openMainWindowSettings}
        onNavigateHistory={() => setPage("history")}
        onManageTrusted={() => {
          setPage("devices");
          setTrustedOnly(true);
        }}
        onOpenUno={(m) => setOverlay(m)}
      />
    ) : (
      <RcA2DeviceDetail
        target={selectedTarget}
        check={selectedId ? rc.reachability[selectedId] : undefined}
        channelUp={rc.status ? channelUp : null}
        busy={rc.busy}
        locked={hasLiveSession}
        lockedLabel={lockedLabel}
        historyList={history.list}
        ui={deviceUi}
        onConnect={(id, capability) => void doRequest(id, capability)}
        onSendFiles={openFiles}
        onPair={() => setOverlay("pair")}
        onSetAllowed={(id, allowed) => rc.setDeviceAllowed(id, allowed)}
        onSetTrust={(id, trusted) => rc.setDeviceTrust(id, trusted)}
        onSetAutoAccept={(id, enabled) => rc.setDeviceAutoAccept(id, enabled)}
        onForget={forgetDevice}
        onRename={(id, note) => saveDeviceField(() => rcDeviceRename(id, note))}
        onSetTags={(id, tags) => saveDeviceField(() => rcDeviceTagsSet(id, tags))}
        onSetRemark={(id, remark) => saveDeviceField(() => rcDeviceRemarkSet(id, remark))}
        onViewHistory={() => setPage("history")}
        capFor={capOf}
        toast={toast}
      />
    );

  /* 会话态收掉工作台标题栏（画面接管整个工作台）。判据收口在
     `hidesWorkbenchTitleBar`（lib/rcWorkbenchA2），带守卫单测——这里只消费结论。
     窗口 `decorations(false)` 后无系统标题栏：常态由 `RcA2TitleBar` 兼作拖拽区，
     会话态（本条不渲染）则由 `RcSessionTop` 顶上拖拽区 + 关闭键，两处各管一态。 */
  const chromeHidden = hidesWorkbenchTitleBar(surface);

  return (
    <div className={styles.workbench} data-rc-root="">
      {!chromeHidden && (
        <RcA2TitleBar
          channelUp={channelUp}
          busy={rc.busy}
          sessionLabel={sessionLabel}
          onStartChannel={startChannel}
        />
      )}

      <div className={styles.workbenchBody}>
        {!chromeHidden && (
          <RcA2Sidebar
            page={page}
            targets={rc.targets}
            selectedId={selectedId}
            busy={rc.busy}
            locked={hasLiveSession}
            reachability={rc.reachability}
            channelUp={rc.status ? channelUp : null}
            targetsLoaded={rc.targetsLoaded}
            targetsError={rc.targetsError}
            onSelect={setSelectedPeer}
            onRefresh={refreshDeviceChecks}
            onPair={() => setOverlay("pair")}
            onNavigate={setPage}
            rc={rc}
            toast={toast}
            selfEnabled={rc.status?.enabled ?? false}
            onToggleSelf={(enabled) => void rc.setEnabled(enabled)}
            onUnoGenerate={() => setOverlay("unoGenerate")}
            onHelp={() => setOverlay("help")}
            historyFilter={{
              devices: historyDevices,
              total: history.list.length,
              peer: historyPeer,
              onSelect: setHistoryPeer,
            }}
            capFor={capOf}
            transferBadge={transfer.running}
            transferStrip={transfer.strip}
            trustedOnly={trustedOnly}
            onExitTrustedFilter={() => setTrustedOnly(false)}
          />
        )}
        <div className={styles.mainColumn}>
          {/* 错误条只服务页面态：stage 顶部自带 RcErrorPanel，双挂会出两条 */}
          {rc.error && !onStage && (
            <RcWorkbenchErrorSlot
              error={rc.error}
              isOpError={rc.isOpError}
              lastAttempt={lastAttempt}
              targets={rc.targets}
              capFor={capOf}
              onRequest={(id, c) => void doRequest(id, c)}
              onRefresh={() => void rc.refresh()}
              onDismiss={rc.clearError}
            />
          )}
          <div className={styles.mainSurface}>{onStage ? stage : content}</div>
        </div>
      </div>

      {/* 2026-09-23：入站申请条原先只挂主窗——停在工作台时别人申请控本机毫无提示 */}
      <RcJoinRequests
        pending={rc.status?.pending ?? []}
        busy={rc.busy}
        onApprove={(id) => {
          void rc.approve(id).then((ok) => {
            if (ok) toast("已同意远程协助", "success");
            else toast("同意失败，请重试（申请可能已过期）", "error");
          });
        }}
        onDeny={(id) => {
          void rc.deny(id).then((ok) => {
            if (ok) toast("已拒绝远程申请", "info");
          });
        }}
      />
      <RcPairLayer
        rc={rc}
        toast={toast}
        mode={overlay}
        onClose={() => setOverlay(null)}
        onStartRemote={(peerId) => void doRequest(peerId, capOf(peerId))}
        onPairAccepted={(peerId) => setSelectedPeer(peerId)}
      />
    </div>
  );
}
