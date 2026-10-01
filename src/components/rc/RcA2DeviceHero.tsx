/**
 * RcA2DeviceHero — 详情面头（拼装稿 2026-09-26 全量对齐版）。
 *
 * 显示器插画、设备名与状态、事实胶囊、默认连接动作和另一个连接模式。
 * 连接档位由设备记忆决定，另一种模式始终有直达按钮。
 * 改名草稿态仍在工作台层（`useRcDeviceUi`，规则 15.2），本组件只渲染与转发。
 */
import { useState } from "react";
import { Activity, Check, Eye, FileUp, Monitor, MousePointer2, Pencil, Shield, X } from "lucide-react";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import { rcCheckTime, rcDeviceStatus } from "@/lib/utils";
import { RcA2ConnectAction } from "./RcA2ConnectAction";
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
  // 审计 P2（2026-09-27）：这颗 ？ 原先只有 title 没有 onClick——button 语义许诺了
  // 交互却不兑现（键盘 Tab 到它按 Enter 毫无反馈）。现在点击就地展开同一段解释，
  // 悬停（title）与点击（aria-expanded 提示）两条路都能拿到答案。
  const [showStatusHint, setShowStatusHint] = useState(false);
  const statusHint =
    "状态来自本机最近一次连接检查，点侧栏「重新检查」可立即刷新。";
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
            aria-expanded={showStatusHint}
            title={statusHint}
            onClick={() => setShowStatusHint((v) => !v)}
          >
            ?
          </button>
        </p>
        {showStatusHint && (
          <p className={styles.heroHelpHint} role="note">
            {statusHint}
          </p>
        )}
        {/* 系统、路径与延迟只在有实测数据时显示；连接状态已在上一行。 */}
        <div className={styles.heroChips}>
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
        <RcA2ConnectAction
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
          title={heroCap === "view" ? "可操作对方键鼠与剪贴板" : "仅查看画面，不能操作对方键鼠"}
          onClick={() => onConnect(target.node_id, heroCap === "view" ? "control" : "view")}
        >
          {heroCap === "view" ? <MousePointer2 size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
          {heroCap === "view" ? "可控" : "只看"}
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
