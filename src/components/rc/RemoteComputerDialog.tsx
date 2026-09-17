/**
 * RemoteComputerDialog — 工具箱主面板。
 * 会话中关闭需确认；设备列表/申请等待拆在子组件。
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
import type { RcCapability } from "@/lib/api/rc";
import { lastRequestCap, rememberRequestCap } from "@/lib/rcRequest";
import styles from "./RemoteComputer.module.css";

const LS_LAST = "rc_last_peer";

export function RemoteComputerDialog({ onClose }: { onClose: () => void }) {
  const anim = useDialogAnim();
  const { toast } = useToast();
  const rcEnabledSelf = useAppStore((s) => s.config.rc_enabled);
  const rc = useRc(true);
  /**
   * 发起用的能力档：来自上次（`lib/rcRequest`），不再是每次打开都重置的 "view"。
   * 用 state 而不是只读常量——行菜单换档后主按钮 tooltip 要立刻跟着改。
   */
  const [cap, setCap] = useState<RcCapability>(() => lastRequestCap());
  /**
   * 上一次「发起」指向的设备。
   * 用 `lastPeer` 做重试是错的：它只记**成功**过的设备，
   * 申请失败时重试会打到另一个设备上。
   */
  const [lastAttempt, setLastAttempt] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [lastPeer, setLastPeer] = useState<string | null>(null);
  /** 打开面板只探一次；之后靠手动「检测」或发起远程，不空转。 */
  const probedOnce = useRef(false);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    void rc.refresh();
    void rc.refreshIdentity();
    try {
      setLastPeer(localStorage.getItem(LS_LAST));
    } catch {
      /* ignore */
    }
    // 先拉列表，再对非 live 设备探活（设计稿：按需探活）
    void (async () => {
      await rc.refreshTargets();
      if (!probedOnce.current) {
        probedOnce.current = true;
        await rc.probeTargets();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = rc.status?.session ?? null;
  const active = session?.phase === "outbound_active";
  const pending = session?.phase === "outbound_pending";
  const channelUp = rc.status?.running ?? false;
  const hasTargets = rc.targets.length > 0;
  const hasLiveSession = !!(session && session.phase !== "idle");

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
    setLastAttempt(id);
    const ok = await rc.request(id, c);
    if (ok) {
      // 成功才记「上次用的档」与「上次的设备」——失败不该污染记忆
      setCap(c);
      rememberRequestCap(c);
      try {
        localStorage.setItem(LS_LAST, id);
        setLastPeer(id);
      } catch {
        /* ignore */
      }
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
                      ? lastAttempt
                        ? () => void doRequest(lastAttempt, cap)
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
                  /** B-1 会话内提权：协议层无中途信令通道 ⇒ 重新协商式
                   *  （结束当前会话 + 重新申请「可控」），与 onReconnect 同一条链路。 */
                  onRequestControl={async () => {
                    await rc.end();
                    await doRequest(session.peer, "control");
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
                  /** B：等待态改档零成本——作废重发，对端只看到一次新敲门。 */
                  onRaise={
                    session.capability !== "control"
                      ? async () => {
                          await rc.cancel();
                          await doRequest(session.peer, "control");
                        }
                      : undefined
                  }
                />
              ) : (
                <>
                  {!hasTargets ? (
                    <RcEmptyGuide onPair={() => setPairOpen(true)} />
                  ) : !channelUp ? (
                    <div className={styles.noteWarn}>
                      已配对 {rc.targets.length} 台，但远程通道未启动。
                      {/* B：这里原来还有一句「开通道只用于你去远程别人；允许被远程…」——
                          与面板底部 foot 说的是同一件事，同屏两遍。已删，只留 foot。 */}
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
                      {/* B：删掉「上次控制 / 重连『x』」整行——它与点设备行的
                          「发起」是同一个动作，`lastPeer` 只保留设备行的「上次」徽章作用。 */}
                      <RcDeviceList
                        targets={rc.targets}
                        lastPeer={lastPeer}
                        deviceDeny={rc.status?.device_deny ?? {}}
                        busy={rc.busy}
                        requestCap={cap}
                        onRequest={(id) => void doRequest(id, cap)}
                        onRequestWith={(id, c) => void doRequest(id, c)}
                        onForget={forgetDevice}
                        onSetAllowed={async (id, allowed) => rc.setDeviceAllowed(id, allowed)}
                        onPair={() => setPairOpen(true)}
                        toast={toast}
                      />
                      <div className={styles.recentRow}>
                        <button
                          type="button"
                          className={styles.miniBtn}
                          disabled={probing}
                          title="对非「在线」设备短超时探测一次（打开面板时也会自动探）"
                          onClick={() => {
                            setProbing(true);
                            void rc.probeTargets().finally(() => setProbing(false));
                          }}
                        >
                          {probing ? "检测中…" : "检测在线"}
                        </button>
                        <button
                          type="button"
                          className={`${styles.miniBtn} ${styles.ml8}`}
                          onClick={() => setPairOpen(true)}
                        >
                          ＋ 再配对一台
                        </button>
                      </div>
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
        <RcPairDialog
          rc={rc}
          toast={toast}
          onClose={() => setPairOpen(false)}
          /* 配对完的第一意图几乎总是「马上连过去」：直接把出口给到，别让用户
             走回设备列表再点一次（设计稿 §4.4，结论见 §8 #5）。能力档沿用当前档。 */
          onStartRemote={(peerId) => void doRequest(peerId, cap)}
        />
      )}
    </AnimatePresence>
  );
}
