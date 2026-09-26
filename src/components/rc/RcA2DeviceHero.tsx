/**
 * RcA2DeviceHero — 详情面头（拼装稿 2026-09-26 全量对齐版）。
 *
 * 五块：右上标语笔触、显示器插画（纯 CSS，渐变全走 theme.css hero 令牌）、
 * 名字/改名（铅笔图标，稿口径）、状态行（彩点 + ? 气泡就地解释）、
 * 事实胶囊行（在线 pill + OS/路径/RTT 带图标），右下动作组
 * （分体大钮 + 常驻「只看」「传文件」——稿 `.hero-actions`，只看从 ⌄
 * 菜单里回到常驻，菜单仍保留选档）。
 * 改名草稿态仍在工作台层（`useRcDeviceUi`，规则 15.2），本组件只渲染与转发。
 */
import { Activity, Check, Eye, FileUp, Monitor, Pencil, Shield, X } from "lucide-react";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import { rcCheckTime, rcDeviceStatus } from "@/lib/utils";
import { RcA2ConnectSplit } from "./RcA2ConnectSplit";
import styles from "./RemoteComputerA2.module.css";

export function RcA2DeviceHero({
  target,
  name,
  status,
  deviceOs,
  connection,
  measuredRtt,
  heroCap,
  busy,
  cannotConnect,
  disabledReason,
  editingName,
  draftName,
  savingName,
  onDraftName,
  onEditStart,
  onEditCancel,
  onSaveName,
  onConnect,
  onSendFiles,
}: {
  target: RcTargetDevice;
  name: string;
  status: ReturnType<typeof rcDeviceStatus>;
  deviceOs: string;
  connection: string;
  measuredRtt: number;
  heroCap: RcCapability;
  busy: boolean;
  cannotConnect: boolean;
  disabledReason: string;
  editingName: boolean;
  draftName: string;
  savingName: boolean;
  onDraftName: (value: string) => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onSaveName: () => void;
  onConnect: (id: string, capability: RcCapability) => void;
  onSendFiles: (id: string) => void;
}) {
  return (
    <header className={styles.detailHead}>
      <span className={styles.heroSlogan} aria-hidden="true">
        让距离，不再是距离
      </span>
      <div className={styles.heroDevice} aria-hidden="true">
        <span className={styles.heroMonitor}>
          <span className={styles.heroScreen} />
          <span className={styles.heroNeck} />
          <span className={styles.heroBase} />
        </span>
        <span className={styles.heroPedestal} />
      </div>
      <div className={styles.detailName}>
        {editingName ? (
          <div className={styles.renameForm}>
            <input
              value={draftName}
              aria-label="设备备注名"
              autoFocus
              onChange={(event) => onDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSaveName();
                if (event.key === "Escape") onEditCancel();
              }}
            />
            <button type="button" aria-label="保存名称" disabled={savingName} onClick={onSaveName}>
              <Check size={14} aria-hidden="true" />
            </button>
            <button type="button" aria-label="取消改名" onClick={onEditCancel}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : target.source === "rc" ? (
          <div className={styles.detailTitleRow}>
            <h2>{name}</h2>
            <button type="button" aria-label="重命名设备" onClick={onEditStart}>
              <Pencil size={14} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <h2>{name}</h2>
        )}
        <p>
          <span className={styles.heroStatusDot} data-tone={status.tone} aria-hidden="true" />
          <span className={styles.onlineText} data-tone={status.tone}>
            {status.label}
          </span>
          {status.checkedAt && <span> · {rcCheckTime(status.checkedAt)} 检查</span>}
          <button
            type="button"
            className={styles.heroHelp}
            aria-label="这个状态是什么意思"
            title="状态来自本机最近一次连接检查，点侧栏「重新检查」可立即刷新"
          >
            ?
          </button>
        </p>
        {/* hero 胶囊行（稿 `.hero-chips`）：OS 与 RTT 都是「采不到就整段不出」，不编占位。 */}
        <div className={styles.heroChips}>
          {/* U8 后状态行文案是「局域网在线」，pill 判据按 presence 判，
              别绑字符串（文案再改这里就静默失效） */}
          {target.presence === "live" && (
            <span className={styles.detailPill}>
              <i className={styles.detailPillDot} aria-hidden="true" />
              在线
            </span>
          )}
          {deviceOs && (
            <span className={styles.heroChip}>
              <Monitor size={12} aria-hidden="true" />
              {deviceOs}
            </span>
          )}
          {target.last_path && (
            <span className={styles.heroChip}>
              <Shield size={12} aria-hidden="true" />
              {connection}
            </span>
          )}
          {measuredRtt > 0 && (
            <span className={styles.heroChip} title="最近一次会话实测往返延迟">
              <Activity size={12} aria-hidden="true" />
              最近实测 ~{measuredRtt} ms
            </span>
          )}
        </div>
      </div>
      <div className={styles.detailActions}>
        {/* 连接仍只此一颗分体大钮（⌄ 选档直发）；只看/传文件按稿常驻右下 */}
        <RcA2ConnectSplit
          targetId={target.node_id}
          name={name}
          cap={heroCap}
          denied={Boolean(target.denied)}
          disabled={busy || cannotConnect}
          disabledReason={disabledReason}
          onConnect={onConnect}
        />
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy || cannotConnect}
          title="仅查看画面，不能操作对方键鼠"
          onClick={() => onConnect(target.node_id, "view")}
        >
          <Eye size={14} aria-hidden="true" />
          只看
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy || target.source !== "rc"}
          onClick={() => onSendFiles(target.node_id)}
        >
          <FileUp size={14} aria-hidden="true" />
          传文件
        </button>
      </div>
    </header>
  );
}
