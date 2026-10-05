/**
 * 首页使用 requestsOnly：不渲染附近列表，只在对方发起时弹出核对。
 * 必须保留 5 秒来访观察，rc_nearby_status 还是后端握手重传的驱动点。
 * 统一配对弹窗接手时暂停此观察者，避免双重完成通知。
 * 默认卡片模式仍保留给旧宿主兼容；新的首页不再挂载其列表。
 */
import { useEffect, useRef, useState } from "react";
import { Radar } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
import { NEARBY_IDLE_POLL_MS, useRcNearbyPair } from "@/hooks/useRcNearbyPair";
import { RcNearbyList } from "@/components/settings/RcNearbyList";
import { RcPairPin } from "@/components/settings/RcPairPin";
import { RcConnectionShell } from "@/components/settings/RcConnectionShell";
import styles from "./RemoteComputerA2.module.css";

export function RcNearbyPairPane({
  rc,
  toast,
  onPairMore,
  requestsOnly = false,
  suspended = false,
  onPairAccepted,
}: {
  rc: UseRc;
  toast: ToastFn;
  /** 「＋ 配对新设备」：打开统一配对屏（步骤②落地前指现有配对对话框）。 */
  onPairMore: () => void;
  requestsOnly?: boolean;
  suspended?: boolean;
  onPairAccepted?: (id: string) => void;
}) {
  // 首页只观察来访请求，不展示列表；弹窗打开时交给弹窗唯一消费完成状态。
  const near = useRcNearbyPair({ idlePollMs: NEARBY_IDLE_POLL_MS, enabled: !suspended, incomingOnly: requestsOnly });
  /** 这一轮配对是不是从本卡发起的——决定成功 toast 归谁（done 全局只有一个读者）。 */
  const initiatedHere = useRef(false);
  /** 上一轮配对刚刚结束且没成：显示结束条。 */
  const [ended, setEnded] = useState(false);
  const wasPairing = useRef(false);
  /** 消失那一轮的对端。成功判据的兜底用（见下面 varnish effect 的注释）。 */
  const lastPairPeer = useRef<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  const enabled = rc.status?.enabled ?? false;
  const running = rc.status?.running ?? false;

  // 记住这一轮的对端：pair 变 null 的渲染里就拿不到它了，而定性要用。
  useEffect(() => {
    if (near.pair) lastPairPeer.current = near.pair.peer_id;
  }, [near.pair]);

  /* `pair` 消失的那一刻定性。**有 `done` 陪伴 = 成功**（交给下面的 effect
     出 toast）；没 `done` 也**不一定是失败**——`done` 在前端是模块级单读者
     （useRcNearbyPair 的 `shownDoneAtMs`），用户在校验态又从侧栏打开配对
     对话框时，对话框可能把它拿走，而它的处理器已经刷过 targets。所以对端
     此刻已经在设备列表里，同样算配上。 */
  useEffect(() => {
    const has = near.pair !== null;
    if (wasPairing.current && !has) {
      const peer = lastPairPeer.current;
      const paired = Boolean(near.done) || (peer !== null && rc.targets.some((t) => t.node_id === peer));
      setEnded(!paired);
      if (!paired && requestsOnly) toast("这次配对已结束，对方取消或确认超时，请重新发起。", "info");
      if (!paired) void rc.refreshTargets();
    }
    wasPairing.current = has;
    // rc.targets 只在「定性那一刻」读一次，不作为重跑判据——它每一轮探测都会变，
  // 进依赖会让这个 effect 每次刷新设备列表都重跑一遍。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near.pair, near.done]);

  /* 兜底改判：结束条亮着的时候，新设备刷新回来了——说明其实配上了，
     条子自己撤掉。**不补 toast**：成功那一声在能看见 `done` 的那一侧已经
      说过，两边都弹才是重复。 */
  useEffect(() => {
    if (!ended) return;
    const peer = lastPairPeer.current;
    if (peer && rc.targets.some((t) => t.node_id === peer)) {
      lastPairPeer.current = null;
      setEnded(false);
    }
  }, [ended, rc.targets]);

  /* 成功：toast + 刷新列表。只认本卡发起的那一轮——从对话框发起的由对话框
     自己 toast（模块级去重下只有一方看得到 done）。

     **不显式选中新设备**：用户没手动选过时 `resolveRcA2Selection` 会落到
     targets[0]，刚配上来的那台通常就是它；已经选中了别的设备时，抢选中反而
     是打扰。工作台的选中语义自己会处理这两种情况。 */
  useEffect(() => {
    const d = near.done;
    if (!d || (!initiatedHere.current && !requestsOnly)) return;
    initiatedHere.current = false;
    setEnded(false);
    const name = d.peer_name.trim() || fingerprintOf(d.peer_id);
    toast(`已与「${name}」配对，设备已进列表${d.initiator ? "，点「连接」即可发起" : ""}`, "success");
    void rc.refreshTargets();
    onPairAccepted?.(d.peer_id);
    // 只跟 near.done 走：rc/toast 都是稳定引用，进依赖会让副作用被无关渲染重触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near.done]);

  const startPair = async (peerId: string) => {
    initiatedHere.current = true;
    setEnded(false);
    try {
      await near.startPair(peerId);
    } catch (e) {
      initiatedHere.current = false;
      toast(String(e), "error");
    }
  };

  const confirm = async () => {
    try {
      const out = await near.confirm();
      // `waiting` 不是错误（两端确认有先后），核对屏自己会显示「等对方核对…」。
      if (out.state === "gone") {
        initiatedHere.current = false;
        setEnded(true);
      }
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const cancel = async () => {
    initiatedHere.current = false;
    wasPairing.current = false;
    await near.cancel();
    // 取消后回到列表态。不摆结束条——取消是用户的决定，不是失败。
    setEnded(false);
  };

  const enableSelf = async () => {
    setEnabling(true);
    try {
      const ok = await rc.setEnabled(true);
      // 规则 15.1：按钮常驻在卡里，成功/失败的反馈也必须在卡里可见——
      // 成功后 `enabled` 翻转，提示条自己消失；失败才需要 toast。
      if (!ok) toast("开启失败，请重试", "error");
    } finally {
      setEnabling(false);
    }
  };

  if (requestsOnly) {
    if (suspended || !near.pair || near.pair.initiator) return null;
    return <RcConnectionShell title="收到配对请求" subtitle="核对两台设备上的数字，确认是你要连接的设备。" onClose={() => void cancel()}>
      <RcPairPin prompt={near.pair} busy={near.busy} onConfirm={() => void confirm()} onCancel={() => void cancel()} />
    </RcConnectionShell>;
  }

  return (
    <section className={styles.nearbyCard} aria-label="附近的设备">
      {!running && (
        <div className={styles.nearbyChannelHint}>远程通道未启动 · 正在自动开启</div>
      )}
      {running && !enabled && (
        <div className={styles.nearbyPaused}>
          <span>你已暂停「允许别人连接本机」——附近的人仍能和你配对，但连不上你。</span>
          <button
            type="button"
            className={styles.nearbyPausedBtn}
            disabled={enabling}
            onClick={() => void enableSelf()}
          >
            {enabling ? "开启中…" : "去开启"}
          </button>
        </div>
      )}

      {near.pair ? (
        <>
          <h2 className={styles.nearbyCardTitle}>配对进行中</h2>
          <div className={styles.nearbyVerify}>
            <RcPairPin prompt={near.pair} busy={near.busy} onConfirm={() => void confirm()} onCancel={() => void cancel()} />
          </div>
        </>
      ) : (
        <>
          <div className={styles.nearbyCardHead}>
            <Radar size={15} aria-hidden="true" />
            <h2 className={styles.nearbyCardTitle}>附近的设备</h2>
          </div>
          <p className={styles.nearbyCardSub}>
            自动发现同一个网络里的设备。配对只要一次，以后打开就能连。
          </p>
          {ended && (
            <div className={styles.nearbyEnded}>
              这次配对已经结束了——对方取消了，或超过 60 秒没有确认。
              <div className={styles.nearbyEndedBtns}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => { setEnded(false); onPairMore(); }}
                >
                  重新发起
                </button>
                <button
                  type="button"
                  className={styles.probeButton}
                  onClick={() => setEnded(false)}
                >
                  知道了
                </button>
              </div>
            </div>
          )}
          <div className={styles.nearbyCardList}>
            <RcNearbyList
              neighbors={near.neighbors}
              busy={near.busy}
              onPair={(n) => void startPair(n.node_id)}
            />
          </div>
          <button type="button" className={`${styles.primaryButton} ${styles.nearbyCardMainBtn}`} onClick={onPairMore}>
            ＋ 配对新设备
          </button>
          <div className={styles.nearbyCardFoot}>
            没看到对方？点「配对新设备」生成凭证——同一份凭证，二维码和 8 位码都有，
            对方手机扫码、另一台电脑敲码都行。设备名是对方自报的，认不认得准以核对时的那个 8 位码为准。
          </div>
        </>
      )}
    </section>
  );
}
