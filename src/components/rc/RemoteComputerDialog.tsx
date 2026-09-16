/**
 * RemoteComputerDialog — 工具箱主面板。
 * 会话中关闭需确认；设备列表/申请等待拆在子组件。
 */
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { fingerprintOf } from "@/lib/fingerprint";
import { useAppStore } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { useRc } from "@/hooks/useRc";
import { RcPairDialog } from "@/components/settings/RcPairDialog";
import { RcSessionView } from "./RcSessionView";
import { RcQualityBar } from "./RcQualityBar";
import { RcEmptyGuide } from "./RcEmptyGuide";
import { RcDeviceList } from "./RcDeviceList";
import { RcPendingWait } from "./RcPendingWait";
import { RcErrorPanel } from "./RcErrorPanel";
import { RcAskCard } from "./RcAskCard";
import type { RcCapability } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

const LS_LAST = "rc_last_peer";

export function RemoteComputerDialog({ onClose }: { onClose: () => void }) {
  const anim = useDialogAnim();
  const { toast } = useToast();
  const rcEnabledSelf = useAppStore((s) => s.config.rc_enabled);
  const rc = useRc(true);
  const [cap, setCap] = useState<RcCapability>("view");
  const [askPeer, setAskPeer] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [lastPeer, setLastPeer] = useState<string | null>(null);

  useEffect(() => {
    void rc.refresh();
    void rc.refreshTargets();
    void rc.refreshIdentity();
    try {
      setLastPeer(localStorage.getItem(LS_LAST));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = rc.status?.session ?? null;
  const active = session?.phase === "outbound_active";
  const pending = session?.phase === "outbound_pending";
  const channelUp = rc.status?.running ?? false;
  const hasTargets = rc.targets.length > 0;
  const hasLiveSession = !!(session && session.phase !== "idle");

  const lastDevice = useMemo(
    () => rc.targets.find((t) => t.node_id === lastPeer) ?? null,
    [rc.targets, lastPeer],
  );

  const pendingName = useMemo(() => {
    if (!session) return "";
    return (
      session.peer_name ||
      rc.targets.find((t) => t.node_id === session.peer)?.name ||
      fingerprintOf(session.peer)
    );
  }, [session, rc.targets]);

  const requestClose = async () => {
    if (!hasLiveSession) {
      onClose();
      return;
    }
    const ok = await confirmDialog({
      title: "关闭远程电脑",
      message:
        "当前仍有进行中的远程会话。\n确认 = 结束会话并关闭；取消 = 保持会话，仅关闭此窗口。",
      confirmText: "结束会话并关闭",
      cancelText: "保持会话",
      variant: "danger",
    });
    if (ok) {
      await rc.end();
      onClose();
    } else {
      onClose();
    }
  };

  const doRequest = async (id: string, c: RcCapability) => {
    const ok = await rc.request(id, c);
    if (ok) {
      try {
        localStorage.setItem(LS_LAST, id);
        setLastPeer(id);
      } catch {
        /* ignore */
      }
      setAskPeer(null);
    }
    return ok;
  };

  const forgetDevice = async (id: string) => {
    const done = await rc.forget(id);
    if (done && lastPeer === id) {
      setLastPeer(null);
      try {
        localStorage.removeItem(LS_LAST);
      } catch {
        /* ignore */
      }
    }
    return done;
  };

  return (
    <AnimatePresence>
      <motion.div
        {...anim.backdrop}
        className="dialog-backdrop"
        data-rc-root=""
        onClick={() => void requestClose()}
      >
        <FocusTrap>
          <motion.div
            {...anim.panel}
            className="dialog-box"
            style={
              active
                ? { width: "min(960px, 96vw)", maxHeight: "90vh" }
                : { width: "min(560px, 94vw)", maxHeight: "82vh" }
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 className="dialog-title">远程电脑</h2>
              <button
                onClick={() => void requestClose()}
                className="dialog-close"
                aria-label="关闭"
              >
                <X size={15} />
              </button>
            </div>

            <div className={styles.body}>
              {rc.error && (
                <RcErrorPanel
                  error={rc.error}
                  onRetry={
                    rc.isOpError
                      ? askPeer
                        ? () => void doRequest(askPeer, cap)
                        : lastPeer
                          ? () => void doRequest(lastPeer, cap)
                          : undefined
                      : () => void rc.refresh()
                  }
                  onDismiss={() => rc.clearError()}
                />
              )}

              {active && session ? (
                <RcSessionView
                  session={session}
                  busy={rc.busy}
                  onEnd={() => void rc.end()}
                  onReconnect={async () => {
                    await rc.end();
                    await doRequest(session.peer, session.capability);
                  }}
                  rc={rc}
                  quality={rc.status?.quality ?? "balanced"}
                  captureScope={rc.status?.capture_scope ?? "virtual"}
                />
              ) : pending && session ? (
                <RcPendingWait
                  peerName={pendingName}
                  capability={session.capability}
                  startedMs={session.started_ms}
                  busy={rc.busy}
                  onCancel={() => void rc.cancel()}
                />
              ) : (
                <>
                  {!hasTargets ? (
                    <RcEmptyGuide onPair={() => setPairOpen(true)} />
                  ) : !channelUp ? (
                    <div className={styles.noteWarn}>
                      已配对 {rc.targets.length} 台，但远程通道未启动。
                      <br />
                      <span className={styles.devSubNote}>
                        开通道只用于你去远程别人；「允许被远程」在设置里单独控制。
                      </span>
                      <div className={styles.mt10}>
                        <button
                          type="button"
                          className={styles.miniBtnPri}
                          disabled={rc.busy}
                          onClick={() => {
                            void rc.startChannel().then((ok) => {
                              if (ok) toast("远程通道已启动", "success");
                            });
                          }}
                        >
                          开启远程通道
                        </button>
                        <button
                          type="button"
                          className={`${styles.miniBtn} ${styles.ml8}`}
                          onClick={() => setPairOpen(true)}
                        >
                          再配对一台
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {lastDevice && (
                        <div className={styles.recentRow}>
                          <span className={styles.meta}>上次控制</span>
                          <button
                            type="button"
                            className={styles.miniBtnPri}
                            disabled={rc.busy}
                            onClick={() => void doRequest(lastDevice.node_id, cap)}
                          >
                            重连「{lastDevice.name || fingerprintOf(lastDevice.node_id)}」
                          </button>
                        </div>
                      )}
                      <RcDeviceList
                        targets={rc.targets}
                        lastPeer={lastPeer}
                        deviceDeny={rc.status?.device_deny ?? {}}
                        busy={rc.busy}
                        onRequest={(id) => setAskPeer(id)}
                        onForget={forgetDevice}
                        onSetAllowed={async (id, allowed) => rc.setDeviceAllowed(id, allowed)}
                        onPair={() => setPairOpen(true)}
                        toast={toast}
                      />
                      <button
                        type="button"
                        className={`${styles.miniBtn} ${styles.selfStart}`}
                        onClick={() => setPairOpen(true)}
                      >
                        ＋ 再配对一台
                      </button>

                      {askPeer && (
                        <RcAskCard
                          peerId={askPeer}
                          targets={rc.targets}
                          cap={cap}
                          busy={rc.busy}
                          onCap={setCap}
                          onCancel={() => setAskPeer(null)}
                          onSend={() => void doRequest(askPeer, cap)}
                        />
                      )}
                    </>
                  )}
                </>
              )}

              <div className={styles.foot}>
                本机「允许被远程」（{rcEnabledSelf ? "已开" : "关"}）只影响
                <b>别人控你</b>；发起远程不需要打开它。
              </div>
              {!active && !pending && (
                <RcQualityBar
                  rc={rc}
                  quality={rc.status?.quality ?? "balanced"}
                  captureScope={rc.status?.capture_scope ?? "virtual"}
                />
              )}
            </div>
          </motion.div>
        </FocusTrap>
      </motion.div>
      {pairOpen && (
        <RcPairDialog rc={rc} toast={toast} onClose={() => setPairOpen(false)} />
      )}
    </AnimatePresence>
  );
}
