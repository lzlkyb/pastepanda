/**
 * RcWorkbench — 「远程电脑」独立工作台窗口的页面（rc.html 入口，2A 配套）。
 *
 * 为什么要独立窗口：主窗口只有 550×700（tauri.conf.json），原 Dialog 里的
 * 960px 会话视图被压成 ~534px，画面区巴掌大。工作台 1200×780 起（min 960×640），
 * 建窗逻辑在后端 `rc_open_workbench`（照 md-editor 先例）。
 *
 * 布局（v4，2026-09-19）：导航栏（RcNavRail）+ 顶栏（RcTopBar）+ 四个页签：
 *   rc       → 卡片列（RcWorkbenchSide）+ 主区四态（RcStage，判据在 lib/rcWorkbench）
 *   devices  → 设备列表页（RcPageDevices，同一份 targets 的全量浏览）
 *   history  → 会话记录页（RcPageHistory，复用设置页的 RcSessionHistory）
 *   settings → 工作台设置页（RcPageSettings）
 *
 * 🔴 会话折叠（对 v4 稿的一处有意偏差）：出站会话进行中，导航收成 56px 图标轨、
 * 卡片列退场，画面区拿回方案 B 实测的 +220px——照稿全侧栏会把画面压回 ~520px。
 * 展开入口保留（导航轨上的按钮）；离开会话即复位（collapsed 的 effect）。
 *
 * 多窗口轮询说明：rcStore 是**每窗口一份**的模块单例，主窗 + 工作台各跑一份
 * rc_status 轮询。安全性依赖两个后端事实：`status()` 的 path-change 通知自带
 * 去重（take 只被一处消费也无所谓），outbound_error 是 clone 不是 take。
 *
 * ⚠️ 「每窗口一份」还有一个后果：「允许被远程」这类状态**不能读 appStore**
 * （没人给独立窗口水合它），必须读 `rc_status`。见 rcEnabledSelf。
 */
import { useEffect, useRef, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { useToast } from "@/components/Toast";
import { useRc } from "@/hooks/useRc";
import { useRcLaunch } from "@/hooks/useRcLaunch";
import { useRcAdhoc } from "@/hooks/useRcAdhoc";
import { useRcWorkbenchClose } from "@/hooks/useRcWorkbenchClose";
import { RcPairLayer, type RcPairLayerMode } from "@/components/settings/RcPairLayer";
import { RcNavRail } from "./RcNavRail";
import { RcTopBar } from "./RcTopBar";
import { RcStage } from "./RcStage";
import { RcWorkbenchSide } from "./RcWorkbenchSide";
import { RcPageDevices, RcDevicesTopActions } from "./RcPageDevices";
import { RcPageHistory, RcHistoryClearButton } from "./RcPageHistory";
import { RcPageSettings } from "./RcPageSettings";
import {
  isSessionActive,
  workbenchMainMode,
  type WbPage,
} from "@/lib/rcWorkbench";
import { capabilityLabel } from "@/lib/rcRequest";
import { readAutoStartChannel } from "@/lib/rcPrefs";
import { fingerprintOf } from "@/lib/fingerprint";
import styles from "./RemoteComputer.module.css";

export function RcWorkbench() {
  const { toast } = useToast();
  const rc = useRc(true);
  /**
   * 「允许被远程」的唯一真源是**后端** `rc_status.enabled`，不是 appStore。
   * （原先读 appStore 的翻车现场见 git 历史：appStore 在独立窗口恒为 DEFAULT，
   * 开关视觉恒「关」。）设置页一直读 status，所以两边一致。
   */
  const rcEnabledSelf = rc.status?.enabled ?? false;
  /** 发起链路的记忆与动作（能力档 / 上次设备 / 重试目标 / 撤销窗口）——见 useRcLaunch。 */
  const { cap, setDefaultCap, lastPeer, lastAttempt, doRequest, forgetDevice } = useRcLaunch(rc, toast);
  /** 当前开着的弹层：长期配对 / 让别人帮我 / 帮别人连一次（见 RcPairLayer）。 */
  const [overlay, setOverlay] = useState<RcPairLayerMode>(null);
  /** v4 导航态：「远程电脑」是主页，其余三页见顶部说明。 */
  const [page, setPage] = useState<WbPage>("rc");
  /**
   * 会话进行中左列是否被**手动**展开。默认收起把宽度让给画面；
   * 非会话状态下一律展开（collapsed 的 effect 负责复位）。
   */
  const [sideOpen, setSideOpen] = useState(false);
  /** 打开只探一次活；之后靠手动「检测」或发起远程，不空转。 */
  const probedOnce = useRef(false);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    void rc.refresh();
    void rc.refreshIdentity();
    void (async () => {
      await rc.refreshTargets();
      if (!probedOnce.current) {
        probedOnce.current = true;
        await rc.probeTargets();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mode = workbenchMainMode(rc.status);
  const active = mode === "outbound";
  const pending = mode === "pending";
  const inbound = mode === "inbound";
  const session = rc.status?.session ?? null;
  const channelUp = rc.status?.running ?? false;
  const hasTargets = rc.targets.length > 0;
  const hasLiveSession = isSessionActive(rc.status);

  /**
   * 「启动工作台时自动开启远程通道」（设置页偏好，lib/rcPrefs）。
   * 只在**首次 rc_status 回包**（成功或失败）之后动作：之前不知道通道在不在跑；
   * 后端 svc.start 自带运行中守卫，就算撞上重复 start 也是 no-op。
   * 静默成功（顶栏 chip 变绿已可见），失败才提醒。
   */
  const [autoStartDone, setAutoStartDone] = useState(false);
  /** 会话记录页的刷新纪元：顶栏清空记录成功后 +1，用 key 重挂页面重新拉列表。 */
  const [historyEpoch, setHistoryEpoch] = useState(0);
  useEffect(() => {
    if (autoStartDone) return;
    if (rc.status === null && rc.error === null) return; // 首包未到，再等一等
    setAutoStartDone(true);
    if (readAutoStartChannel() && !channelUp) {
      void rc.startChannel().then((ok) => {
        if (!ok) toast("远程通道自动启动失败，可点顶栏「远程通道未启动」重试", "error");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 首包判据一到位就动作一次，不随轮询重放
  }, [autoStartDone, channelUp]);

  /**
   * 侧栏收起（方案 B）：**只在出站会话进行中**（有画面）才收——被控时主区是信息卡、
   * 没有画面，收窄侧栏换不来任何东西，反而把「允许被远程」这类本机状态藏起来。
   */
  const collapsed = active && !sideOpen;
  useEffect(() => {
    if (!active) setSideOpen(false);
  }, [active]);

  // 会话中点系统关闭钮：沿用原 Dialog 的确认语义（结束会话 or 保持会话仅关窗）。
  useRcWorkbenchClose(hasLiveSession, rc.end);

  /** 一次性协助的「用后即忘」结账点（判据在 `lib/rcAdhoc`）。 */
  useRcAdhoc(rc);

  /** 跳主窗口设置页的 rc 分区（跨窗口只能走 Tauri 事件，主窗里有桥） */
  const openMainWindowSettings = () => {
    void emitTo("main", "pp:open-settings-rc").catch(() => {
      toast("跳转设置失败：主窗口不可达", "error");
    });
  };

  const lockedLabel = inbound
    ? "对方正在远程本机"
    : pending
      ? "已有申请在等对方同意"
      : "远程会话进行中";

  /** 顶栏会话 chip 的一行状态；空 = 不摆。 */
  const sessionLabel = !session
    ? ""
    : inbound
      ? "对方正在远程本机"
      : pending
        ? "等待对方同意接入"
        : `正在远程控制 ${session.peer_name || fingerprintOf(session.peer)} · ${capabilityLabel(session.capability)}`;

  /** 共享回调束：三个页面与主页用的同一批发起/配对动作。 */
  const startChannel = () => {
    void rc.startChannel().then((ok) => {
      if (ok) toast("远程通道已启动", "success");
    });
  };
  const probe = () => {
    setProbing(true);
    void rc.probeTargets().finally(() => setProbing(false));
  };
  const requestCap = (id: string) => void doRequest(id, cap);
  const requestWith = (id: string, c: Parameters<typeof doRequest>[1]) =>
    void doRequest(id, c);

  return (
    <div className={styles.wbPage} data-rc-root="">
      <RcNavRail
        page={page}
        compact={collapsed}
        selfEnabled={rcEnabledSelf}
        channelUp={channelUp}
        identity={rc.identity}
        onNavigate={setPage}
        onExpand={() => setSideOpen(true)}
        onStartChannel={startChannel}
      />

      <div className={styles.wbCol}>
        <RcTopBar
          page={page}
          channelUp={channelUp}
          busy={rc.busy}
          sessionLabel={sessionLabel}
          /* v4 对稿（B 窗）：会话 chip 带每秒走字的时长（计时器在 live region 外）。 */
          sessionStartedMs={session?.started_ms}
          /* v4 对稿（C 窗）：设备列表页副标题念实时计数；其余页沿用静态 meta。 */
          hintOverride={
            page === "devices"
              ? `共 ${rc.targets.length} 台 · ${rc.targets.filter((t) => t.presence === "live").length} 台在线`
              : undefined
          }
          /* v5：devices 页动作 = 检测在线 + 配对设备；history 页动作 = 清空记录。
             JSX 外移到各自页面文件（RcDevicesTopActions / RcHistoryClearButton）。 */
          actions={
            page === "devices" ? (
              <RcDevicesTopActions probing={probing} onProbe={probe} onPair={() => setOverlay("pair")} />
            ) : page === "history" ? (
              <RcHistoryClearButton
                rc={rc}
                toast={toast}
                onCleared={() => setHistoryEpoch((n) => n + 1)}
              />
            ) : undefined
          }
          onStartChannel={startChannel}
          onOpenSettings={() => setPage("settings")}
        />

        {page === "devices" ? (
          <RcPageDevices
            rc={rc}
            toast={toast}
            cap={cap}
            lastPeer={lastPeer}
            locked={hasLiveSession}
            lockedLabel={lockedLabel}
            onPair={() => setOverlay("pair")}
            onStartChannel={startChannel}
            onForget={forgetDevice}
            onRequest={requestCap}
            onRequestWith={requestWith}
          />
        ) : page === "history" ? (
          <RcPageHistory
            key={historyEpoch}
            rc={rc}
            onReconnect={(id, _name, c) => void doRequest(id, c)}
          />
        ) : page === "settings" ? (
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
          <div className={styles.wbBody}>
            {!collapsed && (
              <RcWorkbenchSide
                rc={rc}
                rcEnabledSelf={rcEnabledSelf}
                cap={cap}
                lastPeer={lastPeer}
                probing={probing}
                channelUp={channelUp}
                hasTargets={hasTargets}
                locked={hasLiveSession}
                lockedLabel={lockedLabel}
                toast={toast}
                onToggleSelf={(v) => void rc.setEnabled(v)}
                onPair={() => setOverlay("pair")}
                onHelpMe={() => setOverlay("helpMe")}
                onHelpOther={() => setOverlay("helpOther")}
                onProbe={probe}
                onStartChannel={startChannel}
                onRequest={requestCap}
                onRequestWith={requestWith}
                onForget={forgetDevice}
                /* 收起按钮只在有画面时才有意义（见上面 collapsed 的说明） */
                onCollapse={active ? () => setSideOpen(false) : undefined}
              />
            )}
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
          </div>
        )}
      </div>

      {/* 配对 / 一次性协助两个弹层都由它挂（见 RcPairLayer 的说明）。 */}
      <RcPairLayer
        rc={rc}
        toast={toast}
        mode={overlay}
        onClose={() => setOverlay(null)}
        /* 配对/连上完的第一意图几乎总是「马上连过去」：出口直接给到，能力档沿用当前档。 */
        onStartRemote={(peerId) => void doRequest(peerId, cap)}
      />
    </div>
  );
}
