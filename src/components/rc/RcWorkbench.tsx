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
import { useRcAdhoc } from "@/hooks/useRcAdhoc";
import { useRcDeviceUi } from "@/hooks/useRcDeviceUi";
import { useRcHistory } from "@/hooks/useRcHistory";
import { useRcLaunch } from "@/hooks/useRcLaunch";
import { useRcWorkbenchClose } from "@/hooks/useRcWorkbenchClose";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDeviceRename } from "@/lib/api/rc";
import { normalizeHistoryPeer, summarizeHistoryDevices } from "@/lib/rcHistory";
import { readAutoStartChannel } from "@/lib/rcPrefs";
import { capabilityLabel } from "@/lib/rcRequest";
import { isSessionActive, workbenchMainMode } from "@/lib/rcWorkbench";
import { resolveRcA2Selection, resolveRcA2Surface, hidesWorkbenchTitleBar, type RcA2Page } from "@/lib/rcWorkbenchA2";
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
  const history = useRcHistory();
  // P3-7：改名草稿/管理展开挂在工作台层——详情面随切页卸载会丢草稿（规则 15.2）
  const deviceUi = useRcDeviceUi();
  const [overlay, setOverlay] = useState<RcPairLayerMode>(null);
  const [page, setPage] = useState<RcA2Page>("devices");
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [historyPeerRaw, setHistoryPeer] = useState<string | null>(null);
  const [autoStartDone, setAutoStartDone] = useState(false);

  const historyDevices = useMemo(() => summarizeHistoryDevices(history.list), [history.list]);
  /* 传下去的永远是有效筛选值：设备被移除 / 记录被清空后退回「全部设备」，
     避免侧栏出现「一项都没选中」的空列表死角。state 本身保持原值。 */
  const historyPeer = normalizeHistoryPeer(historyPeerRaw, historyDevices);

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
  // 用户主动点「检测」= 明确要求重探，这里探**单台**是**对的**——与「打开页面自动探」
  // 的区别就在于是不是用户的意思（2026-09-21）。批7 之前这是 titlebar 上的全量按钮
  // （一次并发拨号上限 8 台 × 3s 超时），下放到设备行后语义顺势收窄：用户要确认的
  // 就是这一台，把其它 7 台一起拨一遍只会更慢。
  //
  // 🔴 **通道未启动时显式挡一道**（2026-09-22 实证后补）：`rcStore.probeTargets` 首行是
  //    `if (!status.running) { await refreshTargets(); return; }`——没通道探了也是
  //    `channel_down`。旧址侧栏（`RcWorkbenchSide`，2026-09-22 已作死代码删除）是
  //    **靠「通道未启动时不渲染设备列表」**代管这个前置条件的，入口下放到设备行后那层
  //    代管没了，于是「检测」变成**静默死按钮**：实测 `rc_probe_targets` 调用 0 次、
  //    无 toast、无 error。守卫写在调用侧而不是按钮的 `disabled` 上——禁用态在部分平台
  //    不弹 title，用户还是不知道为什么点不动；toast 才能把「先开通道」说出口。
  const probeOne = (id: string) => {
    if (!channelUp) {
      toast("远程通道未启动，请先点顶部状态位「通道未启动 · 点击开启」", "error");
      return Promise.resolve();
    }
    return rc.probeTargets([id]);
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
        onNavigateDevices={() => setPage("devices")}
        onOpenUno={(m) => setOverlay(m)}
      />
    ) : (
      <RcA2DeviceDetail
        target={selectedTarget}
        busy={rc.busy}
        locked={hasLiveSession}
        historyList={history.list}
        ui={deviceUi}
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
        onViewHistory={() => setPage("history")}
        toast={toast}
      />
    );

  /* 会话态收掉工作台标题栏（A 方案稿：画面接管整个工作台）。判据收口在
     `hidesWorkbenchTitleBar`（lib/rcWorkbenchA2），带守卫单测——这里只消费结论。
     连接中 / 等待同意 / 被控态照旧保留标题栏。
     ✅ 批7 已落地：窗口改 `decorations(false)` 后没有系统标题栏，所以常态由
     `RcA2TitleBar` 自己挂 `data-tauri-drag-region="deep"` 兼作拖拽区、自带窗口按钮；
     会话态（本条不渲染）则由 `RcSessionTop` 顶上拖拽区 + 关闭键。两处各管一态。 */
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
            onProbe={probeOne}
            onPair={() => setOverlay("pair")}
            onNavigate={setPage}
            selfEnabled={rc.status?.enabled ?? false}
            onToggleSelf={(enabled) => void rc.setEnabled(enabled)}
            onHelpMe={() => setOverlay("helpMe")}
            onHelpOther={() => setOverlay("helpOther")}
            onUnoJoin={() => setOverlay("unoJoin")}
            historyFilter={{
              devices: historyDevices,
              total: history.list.length,
              peer: historyPeer,
              onSelect: setHistoryPeer,
            }}
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
