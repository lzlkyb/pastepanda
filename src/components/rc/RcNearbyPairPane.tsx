/**
 * RcNearbyPairPane — 远程电脑主页的**常驻配对卡**（统一入口）。
 *
 * 设计稿：`design/远程电脑-一键配对-统一入口-设计稿.html` §1 / §2。
 *
 * # 为什么从折叠里搬到主区
 *
 * 旧入口在侧栏「这台电脑」卡的折叠「更多方式与设备号」里，用户找不到；
 * 配对又是**只用一次但必须先做**的动作，藏起来等于把新用户挡在第一个界面。
 * 现在它是设备页主区的第一块卡：附近能看到的直接点，看不到的走主按钮。
 *
 * # 🔴 一个入口，不让用户判断网络
 *
 * 卡上只有「附近设备点一下」和「＋ 配对新设备」两个动作。
 * 「内网还是公网」「用二维码还是配对码」都不进界面——传输选路由由 iroh 自己做，
 * 界面只回答「我是出示方还是输入方」这件用户天然知道的事。
 *
 * # 卡内原地切核对屏
 *
 * 点「配对」后同一块卡切成配对码核对态（不弹层、不跳页）：两端显示同一个
 * 8 位配对码，一样就各点确认。任一端取消即整轮作废。
 *
 * # 失败不许静默弹回列表（U3）
 *
 * `near.pair` 从有到无且没有 `done` 陪伴时，说明这一轮没成（对方取消 / 60 秒
 * 超时 / 本端 gone）。此时卡里给一条**带原因的结束条 + 重新发起**，
 * 不静默回到列表——那会把失败渲染成「空」。
 *
 * # 暂停提示说的是真实行为
 *
 * `rc_enabled`（允许别人连接本机）只挡**会话建立**，不挡局域网招呼包——
 * 招呼包由 presence 线程发，与开关无关（`rc/service/inbound_accept.rs` 那道闸
 * 才是它真正管的事）。所以提示写「仍能和你配对，但连不上你」，
 * 不写「附近的人看不到你」——后者与代码不符。
 *
 * # 轮询
 *
 * `useRcNearbyPair({ idlePollMs })`：配对进行中 2 秒（UDP 重传等不起），
 * 空闲 5 秒。窗口不可见时 hook 自己停。未实测更激进的优化（事件推送 /
 * 共享请求），所以这里只做间隔收俭。
 */
import { useEffect, useRef, useState } from "react";
import { Radar } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
import { NEARBY_IDLE_POLL_MS, useRcNearbyPair } from "@/hooks/useRcNearbyPair";
import { RcNearbyList } from "@/components/settings/RcNearbyList";
import { RcPairPin } from "@/components/settings/RcPairPin";
import styles from "./RemoteComputerA2.module.css";

export function RcNearbyPairPane({
  rc,
  toast,
  onPairMore,
}: {
  rc: UseRc;
  toast: ToastFn;
  /** 「＋ 配对新设备」：打开统一配对屏（步骤②落地前指现有配对对话框）。 */
  onPairMore: () => void;
}) {
  const near = useRcNearbyPair({ idlePollMs: NEARBY_IDLE_POLL_MS });
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
    if (!d || !initiatedHere.current) return;
    initiatedHere.current = false;
    setEnded(false);
    const name = d.peer_name.trim() || fingerprintOf(d.peer_id);
    toast(`已与「${name}」配对，设备已进列表${d.initiator ? "，点「连接」即可发起" : ""}`, "success");
    void rc.refreshTargets();
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
