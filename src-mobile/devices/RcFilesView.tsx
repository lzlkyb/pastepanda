import { RcDeviceMeta } from "@/components/rc/RcDeviceMeta";
import { rcDisplayName } from "@/lib/rcDevice";
import { RcDeviceIcon } from "@/components/rc/RcDeviceIcon";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FolderDown, FolderOpen, FolderUp } from "lucide-react";
import { MobileChoice } from "../ui/MobileChoice";
import { RcChannelNotice } from "./RcChannelNotice";
import { permissionErrorInfo } from "@/lib/utils";
import { useRcFile } from "@/hooks/useRcFile";
import { useRcFileStore } from "@/stores/rcFileStore";
import type { UseRc } from "@/hooks/useRc";
import { RcFileRecords } from "./RcFileRecords";
import { useMobileFileSend } from "./useMobileFileSend";
import { MobilePage } from "../ui/MobilePage";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import { rcErrorText } from "./rcErrorText";
import { useMobileReceiveDir } from "./useMobileReceiveDir";
import { RcReceiveDirNotice } from "./RcReceiveDirNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcDevices.module.css";

export function RcFilesView({
  rc,
  initialPeer,
  active = true,
  onShowDevices,
  onPeerChange,
  onStatus,
  pageNotice,
}: {
  rc: UseRc;
  initialPeer?: string | null;
  active?: boolean;
  onShowDevices?: () => void;
  onPeerChange?: (peer: string) => void;
  onStatus?: (text: string | null, error?: boolean) => void;
  pageNotice?: ReactNode;
}) {
  const file = useRcFile();
  const directory = useMobileReceiveDir(active);
  const receiveDir = directory.busy ? null : directory.dir;
  const [picked, setPicked] = useState<string | null>(initialPeer ?? null);
  const [choosePeer, setChoosePeer] = useState(false);
  const [showDir, setShowDir] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const pullLock = useRef(false);

  const targets = rc.targets ?? [];
  useEffect(() => {
    if (initialPeer) setPicked(initialPeer);
  }, [initialPeer]);
  const validPicked = targets.some((target) => target.node_id === picked) ? picked : null;
  const peer = validPicked ?? (targets.length === 1 ? targets[0].node_id : null);
  const target = targets.find((item) => item.node_id === peer);
  const peerName = target ? rcDisplayName(target) : "";
  const send = useMobileFileSend(onStatus, peer);
  const [actionPeer, setActionPeer] = useState<string | null>(null);
  const visibleAction = actionPeer === peer;
  const pickerPeer = useRef<{ id: string; name: string } | null>(null);
  const fileErrorPeer = useRcFileStore(s => s.errorPeer);
  const visibleFileError = fileErrorPeer === null || fileErrorPeer === peer ? file.error : null;
  // The native chooser may outlive a peer change; keep its original object explicit.
  const chooseFiles = () => {
    if (!peer || rc.status?.running === false || rc.status?.enabled === false) return;
    pickerPeer.current = { id: peer, name: peerName };
    pickRef.current?.click();
  };
  const pull = async () => {
    if (!peer || !receiveDir || pullLock.current || rc.status?.running === false || rc.status?.enabled === false) return;
    setActionPeer(peer);
    pullLock.current = true;
    setPulling(true);
    setActionErr(null);
    directory.clearNote();
    setActionNote("正在发出取回请求…");
    try {
      const ok = await useRcFileStore.getState().pull(peer, receiveDir);
      if (ok) setActionNote(`已请求 ${peerName || "对方"} 选择文件，请在电脑上确认。`);
      else {
        setActionNote(null);
        setActionErr(useRcFileStore.getState().error ?? "发起取回失败");
      }
    } finally {
      pullLock.current = false;
      setPulling(false);
    }
  };
  const startSend = async (list: FileList | null) => {
    const pickedPeer = pickerPeer.current;
    pickerPeer.current = null;
    if (!pickedPeer || !list?.length) return;
    const files = Array.from(list);
    await send.send(pickedPeer.id, pickedPeer.name, files);
    if (pickRef.current) pickRef.current.value = "";
  };
  return (
    <MobilePage title="文件" subtitle="不接管画面，也能互传文件。" pageNotice={pageNotice}>
      {rc.targetsError && <MobileNotice error title="设备列表未能更新" detail={rcErrorText(rc.targetsError)}
        action={<button className={ui.textButton} onClick={() => void rc.refreshTargets()}>重试</button>} />}
      {visibleFileError && visibleFileError !== (visibleAction ? actionErr : null) && rcErrorText(visibleFileError) !== directory.error && <MobileNotice error title="文件操作未能完成" detail={rcErrorText(visibleFileError)} />}
      <div className={styles.fileLayout}>
      <RcFileRecords file={file} receiveDir={receiveDir} active={active} />
      <section className={styles.fileControls} aria-label="文件传输">
      <RcChannelNotice rc={rc} />
      {targets.length === 0 ? (
        <div className={ui.empty}>
          <FolderOpen aria-hidden="true" />
          <h2>{rc.targetsLoaded === false ? "正在获取设备…" : rc.targetsError ? "暂时无法获取设备" : "还没有配对的电脑"}</h2>
          <p>
            {rc.targetsLoaded === false ? "请稍候，设备就绪后即可选择。" : rc.targetsError ? "请重试更新设备列表，" : "先在「设备」页配对，"}
            <br />
            然后在这里发送、接收和查看进度。
          </p>
          {onShowDevices && (
            <button className={ui.primary} onClick={onShowDevices}>
              前往设备
            </button>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            className={styles.peerSelect}
            onClick={() => setChoosePeer(true)}
            disabled={send.sending || pulling}
          >
            <RcDeviceIcon os={target?.os} size={34} />
            <span>
              <small>传输对象</small>
              <strong>{peerName || "选择一台设备"}</strong>
              {target && <RcDeviceMeta os={target.os} className={styles.deviceType} />}
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          <div className={styles.transferActions}>
            <button
              className={styles.primaryBtn}
              disabled={!peer || send.sending || rc.status?.running === false || rc.status?.enabled === false}
              onClick={chooseFiles}
            >
              <FolderUp size={24} aria-hidden="true" />
              {send.sending ? "正在准备文件…" : "发文件到电脑"}
            </button>
            <button className={styles.ghostBtn} disabled={!peer || !receiveDir || pulling || rc.status?.running === false || rc.status?.enabled === false} onClick={() => void pull()}>
              <FolderDown size={24} aria-hidden="true" />
              {pulling ? "请求中…" : "从电脑取文件"}
            </button>
          </div>
          <p className={ui.hint}>取回时，电脑端需要确认并选择文件。</p>
          <input
            ref={pickRef}
            type="file"
            multiple
            className={styles.filePickInput}
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => void startSend(event.target.files)}
          />
          {send.note && (
            <MobileNotice tone={send.sending ? "pending" : "info"}>{send.note}</MobileNotice>
          )}
          {send.sending && <button type="button" className={ui.secondary} disabled={send.canceling} onClick={send.cancel}>
            {send.canceling ? "正在停止准备…" : "取消本批准备"}
          </button>}
          {send.error && <MobileNotice tone={send.partial ? "warning" : "error"} title={send.partial ? "部分文件未能提交" : "文件未能提交"}
            detail={send.error} onDismiss={send.dismissError}
            action={<button type="button" className={ui.textButton} disabled={!peer || send.sending || rc.status?.running === false || rc.status?.enabled === false} onClick={chooseFiles}>重新选择文件</button>} />}
          {visibleAction && actionNote && (
            <MobileNotice tone={pulling ? "pending" : "info"}>{actionNote}</MobileNotice>
          )}
          {visibleAction && actionErr && <>
            <MobileNotice error title="取回请求未能发出" detail={rcErrorText(actionErr, "file-receive")}
              action={!permissionErrorInfo(actionErr, "file-receive") && <button type="button" className={ui.textButton} disabled={!peer || !receiveDir || pulling || rc.status?.running === false || rc.status?.enabled === false} onClick={() => void pull()}>重试</button>} />
            {permissionErrorInfo(actionErr, "file-receive")?.kind === "file-receive" && (
              <button type="button" className={ui.secondary} disabled={directory.busy} onClick={() => {
                void directory.reset().then(ok => {
                  if (!ok) return;
                  if (useRcFileStore.getState().error === actionErr) useRcFileStore.setState({ error: null, errorPeer: null });
                  setActionErr(null);
                });
              }}>{directory.busy ? "正在重置接收位置…" : "重置接收位置"}</button>
            )}
          </>}
        </>
      )}
      <RcReceiveDirNotice directory={directory} />
      <button className={ui.textButton} onClick={() => setShowDir(true)}>
        <FolderOpen size={18} aria-hidden="true" />
        查看接收位置
      </button>
      </section>

      </div>
      <MobileSheet open={active && choosePeer} title="选择设备" onClose={() => setChoosePeer(false)}>
        <div className={styles.peerPick} role="radiogroup" aria-label="选择设备">
          {targets.map((item) => (
            <MobileChoice key={item.node_id} value={item.node_id} checked={peer === item.node_id}
              title={rcDisplayName(item)} icon={<RcDeviceIcon os={item.os} size={34} />}
              description={<RcDeviceMeta os={item.os} className={styles.deviceType} />}
              onSelect={() => { setPicked(item.node_id); onPeerChange?.(item.node_id); setChoosePeer(false); }} />
          ))}
        </div>
      </MobileSheet>
      <MobileSheet open={active && showDir} title="文件接收位置" onClose={() => setShowDir(false)}>
        <div className={styles.dirCard}>
          <div className={styles.dirLabel}>文件接收目录</div>
          <div className={styles.dirPath}>{receiveDir || directory.error || "正在获取…"}</div>
        </div>
        <p className={ui.hint}>收到的文件存入此目录。文件管理器能否访问取决于系统版本与存储权限。</p>
      </MobileSheet>
    </MobilePage>
  );
}
