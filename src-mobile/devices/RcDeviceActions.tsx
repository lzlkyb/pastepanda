import { RcDeviceMeta } from "@/components/rc/RcDeviceMeta";
import { rcDisplayName } from "@/lib/rcDevice";
import { RcDeviceIcon } from "@/components/rc/RcDeviceIcon";
import { useEffect, useState, type RefObject } from "react";
import { Eye, KeyRound, MousePointer2, Settings2, Unlink, Upload } from "lucide-react";
import type { RcTargetDevice } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { rcDeviceStatus } from "@/lib/utils";
import { rcErrorText } from "./rcErrorText";
import { useMobileDeviceConnect } from "./useMobileDeviceConnect";
import { useMobileBack } from "../ui/useMobileBack";
import { RcChannelNotice } from "./RcChannelNotice";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcDevices.module.css";

export function RcDeviceActions({
  rc,
  backRef,
  target,
  onClose,
  onSendFiles,
  onUno,
}: {
  rc: UseRc;
  backRef?: RefObject<(() => boolean) | null>;
  target: RcTargetDevice;
  onClose: () => void;
  onSendFiles: () => void;
  onUno: () => void;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  const [managing, setManaging] = useState(false);
  const [working, setWorking] = useState<"control" | "view" | "forget" | null>(null);
  const back = () => {
    if (working || rc.busy) return true;
    if (confirmForget) { setConfirmForget(false); return true; }
    if (managing) { setManaging(false); return true; }
    return false;
  };
  useMobileBack(confirmForget || managing, back, true, 20);
  useEffect(() => { if (backRef) backRef.current = back; return () => { if (backRef) backRef.current = null; }; });
  const connection = useMobileDeviceConnect(rc);
  const status = rcDeviceStatus(target.presence, rc.reachability[target.node_id], rc.status?.running ?? null);
  const request = async (capability: "control" | "view") => {
    if (working) return;
    setWorking(capability);
    try {
      if (await connection.request(target, capability)) onClose();
    } finally {
      setWorking(null);
    }
  };
  const forget = async () => {
    if (working || rc.busy) return;
    setWorking("forget");
    try {
      if (await rc.forget(target.node_id)) onClose();
    } finally {
      setWorking(null);
    }
  };
  return (
    <div className={ui.stack}>
      <div className={styles.deviceHero}>
        <RcDeviceIcon os={target.os} size={48} />
        <h2>{rcDisplayName(target, "新设备")}</h2>
        <RcDeviceMeta os={target.os} className={styles.deviceType} />
        <p>{status.label}</p>
      </div>
      {(connection.error || rc.error) && <MobileNotice error title="设备操作未能完成" detail={connection.error || rcErrorText(rc.error)} onDismiss={connection.clearError} />}
      {confirmForget ? (
        <>
          <p className={ui.description}>解除配对后，下次连接需要重新配对。</p>
          <button className={ui.danger} disabled={!!working || rc.busy} onClick={() => void forget()}>
            {working ? "解除中…" : "确认解除配对"}
          </button>
          <button className={ui.secondary} disabled={!!working || rc.busy} onClick={() => setConfirmForget(false)}>
            保留设备
          </button>
        </>
      ) : managing ? (
        <>
          <p className={ui.description}>管理这台设备与本机的配对关系。</p>
          <button className={ui.danger} disabled={!!working || rc.busy} onClick={() => setConfirmForget(true)}>
            <Unlink size={18} aria-hidden="true" />
            解除配对
          </button>
          <button className={ui.secondary} onClick={() => setManaging(false)}>
            返回设备操作
          </button>
        </>
      ) : (
        <>
          <button
            className={ui.primary}
            disabled={!!working || connection.blocked || target.source === "sync"}
            onClick={() => void request("control")}
          >
            <MousePointer2 size={19} aria-hidden="true" />
            {working === "control" ? "正在申请控制…" : "远程控制"}
          </button>
          <button
            className={ui.secondary}
            disabled={!!working || connection.blocked || target.source === "sync"}
            onClick={() => void request("view")}
          >
            <Eye size={19} aria-hidden="true" />
            {working === "view" ? "正在申请观看…" : "只看画面"}
          </button>
          <RcChannelNotice rc={rc} />
          {target.source === "sync" && <p className={ui.hint}>这台设备只有同步关系，请先添加电脑完成远程配对。</p>}
          {target.denied && <p className={ui.hint}>已禁止这台设备连接本机，你仍可以主动连接它。</p>}
          <button className={ui.secondary} disabled={!!working || rc.busy} onClick={onSendFiles}>
            <Upload size={19} aria-hidden="true" />
            传文件
          </button>
          <button className={ui.textButton} disabled={!!working || rc.busy} onClick={onUno}>
            <KeyRound size={19} aria-hidden="true" />
            无人值守接入
          </button>
          <button className={ui.textButton} disabled={!!working || rc.busy} onClick={() => setManaging(true)}>
            <Settings2 size={18} aria-hidden="true" />
            管理设备
          </button>
        </>
      )}
    </div>
  );
}
