/**
 * RcA2DeviceDetail — 右侧设备详情面（选中设备后的「下一步做什么」）。
 *
 * 批5 两处对稿：
 *  ① 「连接与权限」区块标题右侧加「管理此设备」入口，把原先常驻的 4 个权限
 *     按钮（`RcDeviceManageActions`）收进折叠区。折叠态默认关，换设备时重置
 *     ——否则切到另一台还留着上一台的管理面板。
 *  ② 新增「最近会话」3 条（`RcRecentSessions`），数据取工作台那份历史快照。
 *
 * P3-7 / 规则 15.2：改名草稿与管理展开态在**工作台层**（`useRcDeviceUi`），
 * 不放在本组件——切页卸载详情会把未保存的草稿一并丢掉。
 */
import { ChevronDown, ChevronUp, Monitor, SlidersHorizontal } from "lucide-react";
import type { RcCapability, RcHistoryItem, RcTargetDevice } from "@/lib/api/rc";
import type { ToastFn } from "@/components/Toast";
import type { RcReachability } from "@/stores/rcStoreTypes";
import { fingerprintOf } from "@/lib/fingerprint";
import { lastMeasuredRtt } from "@/lib/rcHistory";
import { osLabel, rcDisplayName } from "@/lib/rcDevice";
import { rcDeviceStatus } from "@/lib/utils";
import { pathKindLabel } from "@/lib/rcSessionStats";
import { useRcDeviceActions } from "@/hooks/useRcDeviceActions";
import type { RcDeviceUi } from "@/hooks/useRcDeviceUi";
import { RcA2ConnectionFacts } from "./RcA2ConnectionFacts";
import { RcA2DeviceHero } from "./RcA2DeviceHero";
import { RcA2DeviceOrgEditor } from "./RcA2DeviceOrgEditor";
import { RcDeviceManageActions } from "./RcDeviceManageActions";
import { RcRecentSessions } from "./RcRecentSessions";
import styles from "./RemoteComputerA2.module.css";

function displayName(target: RcTargetDevice): string {
  return rcDisplayName(target, fingerprintOf(target.node_id));
}

export function RcA2DeviceDetail({
  target,
  check,
  channelUp = true,
  busy,
  locked,
  lockedLabel,
  historyList,
  ui,
  onConnect,
  onSendFiles,
  onPair,
  onSetAllowed,
  onSetTrust,
  onSetAutoAccept,
  onForget,
  onRename,
  onSetTags,
  onSetRemark,
  onViewHistory,
  capFor,
  toast,
}: {
  target: RcTargetDevice | null;
  check?: RcReachability;
  channelUp?: boolean | null;
  busy: boolean;
  locked: boolean;
  /** locked 时的原因文案（hero 大钮 title 用，工作台按会话态给）。 */
  lockedLabel?: string;
  /** 工作台级的会话历史快照（与侧栏筛选、记录页同源）。 */
  historyList: RcHistoryItem[];
  /** 改名/管理展开态（上提，见 useRcDeviceUi）。 */
  ui: RcDeviceUi;
  onConnect: (id: string, capability: RcCapability) => void;
  onSendFiles: (id: string) => void;
  onPair: () => void;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  onSetTrust: (id: string, trusted: boolean) => Promise<boolean>;
  onSetAutoAccept: (id: string, autoAccept: boolean) => Promise<boolean>;
  onForget: (id: string) => Promise<boolean>;
  onRename: (id: string, note: string) => Promise<boolean>;
  /** 对齐稿①：标签整组覆盖保存 / 描述备注（仅 rc 表设备有落点，同步配对不摆编辑器）。 */
  onSetTags: (id: string, tags: import("@/lib/api/rc").RcDeviceTag[]) => Promise<boolean>;
  onSetRemark: (id: string, remark: string) => Promise<boolean>;
  /** 「查看全部」跳到记录页。 */
  onViewHistory: () => void;
  /** hero 大钮的发起档（按设备记忆优先，与侧栏行 meta 同源）。 */
  capFor?: (id: string) => RcCapability;
  toast: ToastFn;
}) {
  const {
    editingName,
    setEditingName,
    draftName,
    setDraftName,
    savingName,
    setSavingName,
    manageOpen,
    setManageOpen,
  } = ui;
  const actions = useRcDeviceActions({
    onForget,
    onSetAllowed,
    onTrustToggle: onSetTrust,
    onAutoAcceptToggle: onSetAutoAccept,
    onRename,
    toast,
  });

  /* 换设备收起/清理由工作台层 `deviceUi.syncPeer` 在渲染期处理（规则 15.2：
     草稿态上提，本组件只消费）。 */

  if (!target) {
    return (
      <section className={styles.emptyDetail} aria-labelledby="a2-pair-title">
        <span className={styles.emptyDeviceIcon} aria-hidden="true">
          <Monitor size={28} />
        </span>
        <h2 id="a2-pair-title">配对第一台设备</h2>
        <p>配对只需一次。以后打开远程电脑，选中设备即可连接。</p>
        <button type="button" className={styles.primaryButton} onClick={onPair}>
          开始配对
        </button>
      </section>
    );
  }

  const name = displayName(target);
  const status: ReturnType<typeof rcDeviceStatus> = target.source === "rc"
    ? rcDeviceStatus(target.presence, check, channelUp)
    : { label: "需完成远程配对", tone: "unknown" as const };
  const cannotConnect = locked || target.source !== "rc";
  const connection = pathKindLabel(target.last_path ?? "") || "尚无成功连接记录";
  /* 稿这一格画的是「在线 · Windows 11 · 局域网直连」。系统是对端**自报**的
     （会话 Accept 帧带来的 `target.os`），本机推断不出来——没建立过会话就是空串，
     此时整段不渲染（同「最近实测 RTT」的处理：宁可少一格也不编一个数）。 */
  const deviceOs = osLabel(target.os);
  /* 稿这一格写的是「预计延迟 8–12 ms」——**预计**没有数据源（设备列表不带时延），
     能拿到的只有历史里的会话实测 RTT。所以文案是「最近实测」，采不到样本就整段
     不显示（同历史页对 rtt 的处理：宁可少一格也不编一个数）。 */
  const measuredRtt = lastMeasuredRtt(historyList, target.node_id);
  const heroCap = capFor ? capFor(target.node_id) : "control";
  const saveName = async () => {
    setSavingName(true);
    try {
      const result = await actions.saveRename(target.node_id, draftName);
      setDraftName(result.note);
      if (result.ok) setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <section className={styles.detail} aria-label={`${name}设备详情`}>
      <RcA2DeviceHero
        target={target}
        name={name}
        status={status}
        deviceOs={deviceOs}
        connection={connection}
        measuredRtt={measuredRtt}
        heroCap={heroCap}
        busy={busy}
        cannotConnect={cannotConnect}
        disabledReason={
          target.source !== "rc"
            ? "请先完成远程配对"
            : locked
              ? (lockedLabel || "远程会话进行中")
              : ""
        }
        editingName={editingName}
        draftName={draftName}
        savingName={savingName}
        onDraftName={setDraftName}
        onEditStart={() => {
          setDraftName(target.note?.trim() || target.name?.trim() || "");
          setEditingName(true);
        }}
        onEditCancel={() => setEditingName(false)}
        onSaveName={() => void saveName()}
        onConnect={onConnect}
        onSendFiles={onSendFiles}
      />

      <div className={styles.detailBody}>
        {target.denied && (
          <div className={styles.warningNotice} role="status">
            这台设备已被禁止连接本机。你仍然可以主动连接它。
          </div>
        )}
        {target.source !== "rc" && (
          <div className={styles.warningNotice} role="status">
            这台设备目前只有同步关系，请先完成远程配对。
          </div>
        )}

        <div className={styles.sectionHead}>
          <h3>连接与权限</h3>
          <button
            type="button"
            className={styles.sectionLink}
            aria-expanded={manageOpen}
            aria-controls="rc-a2-manage"
            onClick={() => setManageOpen(!manageOpen)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            管理此设备
            {manageOpen ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
          </button>
        </div>
        {manageOpen && (
          <div id="rc-a2-manage">
            <RcDeviceManageActions
              target={target}
              name={name}
              busy={busy}
              actions={actions}
              onPair={onPair}
            />
            {target.source === "rc" && (
              <RcA2DeviceOrgEditor
                key={target.node_id}
                target={target}
                busy={busy}
                onSetTags={onSetTags}
                onSetRemark={onSetRemark}
                toast={toast}
              />
            )}
          </div>
        )}
        <RcA2ConnectionFacts
          connection={connection}
          hasPath={Boolean(target.last_path)}
          measuredRtt={measuredRtt}
          trusted={Boolean(target.trusted)}
          autoAccept={Boolean(target.auto_accept)}
          fingerprint={fingerprintOf(target.node_id)}
        />

        <RcRecentSessions list={historyList} peer={target.node_id} onViewAll={onViewHistory} />
      </div>
    </section>
  );
}
