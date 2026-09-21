import { useState } from "react";
import { Check, Download, Eye, FileUp, Monitor, Pencil, Play, Shield, ShieldCheck, Trash2, X } from "lucide-react";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import type { ToastFn } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
import { normalizeRcPresence, presenceHint, presenceMainLabel, relTime } from "@/lib/rcDevice";
import { pathKindLabel } from "@/lib/rcSessionStats";
import { useRcDeviceActions } from "@/hooks/useRcDeviceActions";
import styles from "./RemoteComputerA2.module.css";

function displayName(target: RcTargetDevice): string {
  return target.note?.trim() || target.name?.trim() || fingerprintOf(target.node_id);
}

export function RcA2DeviceDetail({
  target,
  busy,
  locked,
  onConnect,
  onSendFiles,
  onPair,
  onSetAllowed,
  onSetTrust,
  onSetAutoAccept,
  onForget,
  onRename,
  toast,
}: {
  target: RcTargetDevice | null;
  busy: boolean;
  locked: boolean;
  onConnect: (id: string, capability: RcCapability) => void;
  onSendFiles: (id: string) => void;
  onPair: () => void;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  onSetTrust: (id: string, trusted: boolean) => Promise<boolean>;
  onSetAutoAccept: (id: string, autoAccept: boolean) => Promise<boolean>;
  onForget: (id: string) => Promise<boolean>;
  onRename: (id: string, note: string) => Promise<boolean>;
  toast: ToastFn;
}) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const actions = useRcDeviceActions({
    onForget,
    onSetAllowed,
    onTrustToggle: onSetTrust,
    onAutoAcceptToggle: onSetAutoAccept,
    onRename,
    toast,
  });

  if (!target) {
    return (
      <section className={styles.emptyDetail} aria-labelledby="a2-pair-title">
        <span className={styles.emptyDeviceIcon} aria-hidden="true">
          <Monitor size={30} />
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
  const presence = normalizeRcPresence(target.presence);
  const cannotConnect = locked || target.source !== "rc";
  const connection = pathKindLabel(target.last_path ?? "") || "尚无成功连接记录";
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
      <header className={styles.detailHead}>
        <span className={styles.detailDeviceIcon} aria-hidden="true">
          <Monitor size={25} />
        </span>
        <div className={styles.detailName}>
          {editingName ? (
            <div className={styles.renameForm}>
              <input
                value={draftName}
                aria-label="设备备注名"
                autoFocus
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveName();
                  if (event.key === "Escape") setEditingName(false);
                }}
              />
              <button type="button" aria-label="保存名称" disabled={savingName} onClick={() => void saveName()}>
                <Check size={14} aria-hidden="true" />
              </button>
              <button type="button" aria-label="取消改名" onClick={() => setEditingName(false)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : target.source === "rc" ? (
            <div className={styles.detailTitleRow}>
              <h2>{name}</h2>
              <button
                type="button"
                aria-label="重命名设备"
                onClick={() => {
                  setDraftName(target.note?.trim() || target.name?.trim() || "");
                  setEditingName(true);
                }}
              >
                <Pencil size={14} aria-hidden="true" />
                重命名
              </button>
            </div>
          ) : (
            <h2>{name}</h2>
          )}
          <p>
            <span className={styles.onlineText} data-presence={presence}>
              {presenceMainLabel(presence, relTime(target.last_seen))}
            </span>
            <span> · {presenceHint(presence)}</span>
          </p>
        </div>
        <div className={styles.detailActions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || cannotConnect}
            onClick={() => onConnect(target.node_id, "control")}
          >
            <Play size={14} aria-hidden="true" />
            连接并控制
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || cannotConnect}
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

        <h3>连接与权限</h3>
        <dl className={styles.factList}>
          <div>
            <dt>上次连接</dt>
            <dd>{connection}</dd>
            <span>{target.last_path ? "来自最近一次会话实测" : "首次连接后显示实际路径"}</span>
          </div>
          <div>
            <dt>连接确认</dt>
            <dd>{target.trusted ? "免确认连接" : "每次由对方确认"}</dd>
            <span>{target.trusted ? "仍可随时结束会话" : "默认更安全"}</span>
          </div>
          <div>
            <dt>文件接收</dt>
            <dd>{target.auto_accept ? "自动接收" : "每次询问"}</dd>
            <span>{target.auto_accept ? "文件会保存到默认目录" : "接受后才写入电脑"}</span>
          </div>
          <div>
            <dt>设备身份</dt>
            <dd className={styles.mono}>{fingerprintOf(target.node_id)}</dd>
            <span>
              <ShieldCheck size={13} aria-hidden="true" /> 已完成配对核验
            </span>
          </div>
        </dl>

        <h3 className={styles.managementTitle}>设备权限</h3>
        <div className={styles.managementActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => void actions.setAllowed(target.node_id, target.denied)}
          >
            <Shield size={14} aria-hidden="true" />
            {target.denied ? "允许连接本机" : "禁止连接本机"}
          </button>
          {target.source === "rc" ? (
            <>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={busy || target.denied}
                onClick={() => void actions.toggleTrust(target.node_id, !target.trusted)}
              >
                <ShieldCheck size={14} aria-hidden="true" />
                {target.trusted ? "关闭免确认连接" : "开启免确认连接"}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={busy || target.denied}
                onClick={() => void actions.toggleAutoAccept(target.node_id, !target.auto_accept)}
              >
                <Download size={14} aria-hidden="true" />
                {target.auto_accept ? "关闭自动接收文件" : "开启自动接收文件"}
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                disabled={busy}
                onClick={() => void actions.forget(target.node_id, name)}
              >
                <Trash2 size={14} aria-hidden="true" />
                移除设备
              </button>
            </>
          ) : (
            <button type="button" className={styles.primaryButton} onClick={onPair}>
              完成远程配对
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
