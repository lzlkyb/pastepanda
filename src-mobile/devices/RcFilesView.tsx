import { RcDeviceMeta } from "@/components/rc/RcDeviceMeta";
import { rcDisplayName } from "@/lib/rcDevice";
import { RcDeviceIcon } from "@/components/rc/RcDeviceIcon";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, FolderDown, FolderOpen, FolderUp } from "lucide-react";
import { permissionErrorInfo } from "@/lib/utils";
import { useRcFile } from "@/hooks/useRcFile";
import { useRcFileStore } from "@/stores/rcFileStore";
import type { UseRc } from "@/hooks/useRc";
import { RcFileTaskList } from "./RcFileTaskList";
import { RcMobileFileAsks } from "./RcMobileFileAsks";
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
  const send = useMobileFileSend(onStatus);
  const targets = rc.targets ?? [];
  useEffect(() => {
    if (initialPeer) setPicked(initialPeer);
  }, [initialPeer]);
  const validPicked = targets.some((target) => target.node_id === picked) ? picked : null;
  const peer = validPicked ?? (targets.length === 1 ? targets[0].node_id : null);
  const target = targets.find((item) => item.node_id === peer);
  const peerName = target ? rcDisplayName(target) : "";
  const pull = async () => {
    if (!peer || !receiveDir || pullLock.current) return;
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
    if (!peer || !list?.length) return;
    const files = Array.from(list);
    await send.send(peer, peerName, files);
    if (pickRef.current) pickRef.current.value = "";
  };
  return (
    <MobilePage title="文件" subtitle="不接管画面，也能互传文件。" pageNotice={pageNotice}>
      {file.error && file.error !== actionErr && rcErrorText(file.error) !== directory.error && <MobileNotice error title="文件操作未能完成" detail={rcErrorText(file.error)} />}
      <div className={styles.fileLayout}>
      <section className={styles.fileControls} aria-label="文件传输">
      {targets.length === 0 ? (
        <div className={ui.empty}>
          <FolderOpen aria-hidden="true" />
          <h2>还没有配对的电脑</h2>
          <p>
            先在「设备」页配对，
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
            disabled={send.sending}
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
              disabled={!peer || send.sending}
              onClick={() => pickRef.current?.click()}
            >
              <FolderUp size={24} aria-hidden="true" />
              {send.sending ? "正在准备文件…" : "发文件到电脑"}
            </button>
            <button className={styles.ghostBtn} disabled={!peer || !receiveDir || pulling} onClick={() => void pull()}>
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
            action={<button type="button" className={ui.textButton} disabled={!peer || send.sending} onClick={() => pickRef.current?.click()}>重新选择文件</button>} />}
          {actionNote && (
            <MobileNotice tone={pulling ? "pending" : "info"}>{actionNote}</MobileNotice>
          )}
          {actionErr && <>
            <MobileNotice error title="取回请求未能发出" detail={rcErrorText(actionErr, "file-receive")}
              action={!permissionErrorInfo(actionErr, "file-receive") && <button type="button" className={ui.textButton} disabled={!peer || !receiveDir || pulling} onClick={() => void pull()}>重试</button>} />
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
      <section className={styles.fileRecords} aria-label="传输记录与请求">
      {file.asks.length > 0 && <div className={ui.sectionHead}>待接收请求</div>}
      <RcMobileFileAsks file={file} receiveDir={receiveDir} active={active} />
      <div className={ui.sectionHead}>
        <span>传输记录</span>
        {file.tasks.length > 0 && (
          <button className={ui.textButton} disabled={file.busy} onClick={() => void file.clearFinished()}>
            清空已完成
          </button>
        )}
      </div>
      {file.tasks.length > 0 ? (
        <RcFileTaskList tasks={file.tasks} rateOf={file.rateOf} onCancel={(id) => void file.cancel(id)} />
      ) : (
        <p className={ui.hint}>还没有传输记录。发送或接收文件后，可以在这里查看进度。</p>
      )}
      </section>
      </div>
      <MobileSheet open={active && choosePeer} title="选择设备" onClose={() => setChoosePeer(false)}>
        <div className={styles.peerPick} role="radiogroup" aria-label="选择设备">
          {targets.map((item) => (
            <button
              type="button"
              key={item.node_id}
              role="radio"
              aria-label={rcDisplayName(item)}
              aria-checked={peer === item.node_id}
              className={`${styles.peerChip} ${peer === item.node_id ? styles.peerChipOn : ""}`}
              onClick={() => {
                setPicked(item.node_id);
                onPeerChange?.(item.node_id);
                setChoosePeer(false);
              }}
            >
              <RcDeviceIcon os={item.os} size={34} />
              <span className={styles.peerDetails}><strong>{rcDisplayName(item)}</strong><RcDeviceMeta os={item.os} className={styles.deviceType} /></span>
              {peer === item.node_id && <Check size={18} aria-hidden="true" />}
            </button>
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
